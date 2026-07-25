import type { AppLogger } from '../common/logger';
import { logStructured } from '../common/structured-log';
import type { IPaymentGateway } from './payment-gateway.port';
import { PaymentProcessingRepository } from './payment-processing.repository';
import {
  computeRetryDelayMs,
  shouldEnqueuePaymentRetry,
  type RetryTimingConfig,
} from './payment-retry.policy';
import type { IPaymentRetryScheduler } from './payment-retry.scheduler.port';

export interface PaymentRecoveryConfig {
  enabled: boolean;
  intervalMs: number;
  minIdleAfterLeaseMs: number;
  batchSize: number;
}

export class PaymentRecoveryService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repository: PaymentProcessingRepository,
    private readonly gateway: IPaymentGateway,
    private readonly logger: AppLogger,
    private readonly scheduler: IPaymentRetryScheduler,
    private readonly retryTiming: RetryTimingConfig,
    private readonly config: PaymentRecoveryConfig,
  ) {}

  start(): void {
    if (!this.config.enabled || this.timer !== null) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runRecoverySweep().catch((error: unknown) => {
        logStructured(this.logger, 'error', {
          event: 'payment.recovery.sweep_failed',
          err: error instanceof Error ? error : new Error(String(error)),
          metadata: {},
        });
      });
    }, this.config.intervalMs);

    logStructured(this.logger, 'info', {
      event: 'payment.recovery.started',
      metadata: { intervalMs: this.config.intervalMs, batchSize: this.config.batchSize },
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runRecoverySweep(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const ids = await this.repository.listStuckProcessingPaymentIds({
      minIdleAfterLeaseMs: this.config.minIdleAfterLeaseMs,
      limit: this.config.batchSize,
    });

    for (const paymentId of ids) {
      await this.recoverPayment(paymentId);
    }
  }

  private async recoverPayment(paymentId: string): Promise<void> {
    const row = await this.repository.loadPaymentRowForRecoveryProbe(paymentId);

    if (!row || row.status !== 'Processing') {
      logStructured(this.logger, 'info', {
        event: 'payment.recovery.skipped',
        paymentId,
        metadata: { reason: 'not_processing_probe' },
      });
      return;
    }

    const cutoffTime = Date.now() - this.config.minIdleAfterLeaseMs;
    if (!row.lockedUntil || row.lockedUntil.getTime() > cutoffTime) {
      logStructured(this.logger, 'info', {
        event: 'payment.recovery.skipped',
        paymentId,
        metadata: { reason: 'not_stuck_probe' },
      });
      return;
    }

    let decision: 'gateway_success' | 'local_failure' = 'local_failure';
    if (row.gatewayReferenceId && this.gateway.getChargeStatus) {
      const gs = await this.gateway.getChargeStatus(row.gatewayReferenceId);
      if (gs === 'success') {
        decision = 'gateway_success';
      }
    }

    const result = await this.repository.applyStaleProcessingRecovery({
      paymentId,
      minIdleAfterLeaseMs: this.config.minIdleAfterLeaseMs,
      decision,
      failureReason: 'recovery_stale_processing',
    });

    if (!result) {
      logStructured(this.logger, 'warn', {
        event: 'payment.recovery.apply_null',
        paymentId,
        metadata: {},
      });
      return;
    }

    logStructured(this.logger, 'info', {
      event: 'payment.recovery.completed',
      paymentId,
      metadata: {
        outcome: result.outcome,
        paymentStatus: result.payment.status,
        gatewayDecision: decision,
      },
    });

    if (
      result.outcome === 'applied_local_failure' &&
      shouldEnqueuePaymentRetry(result.payment)
    ) {
      const delayMs = computeRetryDelayMs(result.payment.retryCount, this.retryTiming);
      await this.scheduler.scheduleRetry({ paymentId: result.payment.id, delayMs });
      logStructured(this.logger, 'info', {
        event: 'payment.recovery.retry_scheduled',
        paymentId: result.payment.id,
        metadata: { delayMs, retryCount: result.payment.retryCount },
      });
    }
  }
}
