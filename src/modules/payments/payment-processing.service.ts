import { GatewayTimeoutError, NotFoundError } from '../common/errors';
import type { AppLogger } from '../common/logger';
import { logStructured, type PaymentLogContext } from '../common/structured-log';
import type { IPaymentGateway } from './payment-gateway.port';
import { PaymentProcessingRepository } from './payment-processing.repository';
import {
  computeRetryDelayMs,
  shouldEnqueuePaymentRetry,
  type RetryTimingConfig,
} from './payment-retry.policy';
import type { IPaymentRetryScheduler } from './payment-retry.scheduler.port';
import type { Payment } from './payment.types';
import type { PaymentWebhookBody } from '../webhooks/payment-webhook.schema';
import type { PaymentWebhookIngestResult } from './payment-processing.repository';

export type ProcessPaymentOutcome =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'skipped_already_success'
  | 'skipped_terminal_failed'
  | 'skipped_busy';

export interface ProcessPaymentResult {
  payment: Payment;
  outcome: ProcessPaymentOutcome;
  attemptNumber?: number;
}

export class PaymentProcessingService {
  constructor(
    private readonly repository: PaymentProcessingRepository,
    private readonly gateway: IPaymentGateway,
    private readonly logger: AppLogger,
    private readonly retryScheduler: IPaymentRetryScheduler,
    private readonly retryTiming: RetryTimingConfig,
  ) {}

  private async maybeScheduleRetryAfterFailure(
    payment: Payment,
    ctx?: PaymentLogContext,
  ): Promise<void> {
    if (!shouldEnqueuePaymentRetry(payment)) {
      logStructured(this.logger, 'debug', {
        event: 'payment.retry.not_scheduled',
        requestId: ctx?.requestId,
        paymentId: payment.id,
        metadata: {
          status: payment.status,
          retryCount: payment.retryCount,
          maxRetries: payment.maxRetries,
        },
      });
      return;
    }

    const delayMs = computeRetryDelayMs(payment.retryCount, this.retryTiming);
    await this.retryScheduler.scheduleRetry({ paymentId: payment.id, delayMs });

    logStructured(this.logger, 'info', {
      event: 'payment.retry.scheduled',
      requestId: ctx?.requestId,
      paymentId: payment.id,
      metadata: { delayMs, retryCount: payment.retryCount },
    });
  }

  async processPaymentById(
    paymentId: string,
    ctx?: PaymentLogContext,
  ): Promise<ProcessPaymentResult> {
    logStructured(this.logger, 'info', {
      event: 'payment.process.requested',
      requestId: ctx?.requestId,
      paymentId,
      metadata: {},
    });

    const claim = await this.repository.claimPaymentForProcessing(paymentId);

    if (claim.kind === 'not_found') {
      logStructured(this.logger, 'warn', {
        event: 'payment.process.not_found',
        requestId: ctx?.requestId,
        paymentId,
        metadata: {},
      });
      throw new NotFoundError('Payment', paymentId);
    }

    if (claim.kind === 'already_success') {
      logStructured(this.logger, 'info', {
        event: 'payment.process.skipped',
        requestId: ctx?.requestId,
        paymentId,
        metadata: { outcome: claim.kind, paymentStatus: claim.payment.status },
      });
      return { payment: claim.payment, outcome: 'skipped_already_success' };
    }

    if (claim.kind === 'terminal_failed') {
      logStructured(this.logger, 'info', {
        event: 'payment.process.skipped',
        requestId: ctx?.requestId,
        paymentId,
        metadata: { outcome: claim.kind, paymentStatus: claim.payment.status },
      });
      return { payment: claim.payment, outcome: 'skipped_terminal_failed' };
    }

    if (claim.kind === 'busy') {
      logStructured(this.logger, 'info', {
        event: 'payment.process.skipped',
        requestId: ctx?.requestId,
        paymentId,
        metadata: { outcome: claim.kind, paymentStatus: claim.payment.status },
      });
      return { payment: claim.payment, outcome: 'skipped_busy' };
    }

    const { payment, attempt } = claim;

    logStructured(this.logger, 'info', {
      event: 'payment.process.claimed',
      requestId: ctx?.requestId,
      paymentId: payment.id,
      metadata: {
        attemptNumber: attempt.attemptNumber,
        fromStatus: payment.status,
      },
    });

    try {
      const gatewayResult = await this.gateway.processPayment({
        id: payment.id,
        amount: payment.amount.toString(),
        currency: payment.currency.trim(),
      });

      if (gatewayResult.outcome === 'success') {
        await this.repository.attachGatewayReferenceForProcessingPayment(
          payment.id,
          gatewayResult.gatewayReferenceId,
        );
        const updated = await this.repository.finalizeSuccess(
          payment.id,
          attempt.id,
          gatewayResult.gatewayReferenceId,
        );

        logStructured(this.logger, 'info', {
          event: 'payment.state.transition',
          requestId: ctx?.requestId,
          paymentId: payment.id,
          metadata: {
            trigger: 'gateway_sync_success',
            toStatus: updated.status,
            attemptNumber: attempt.attemptNumber,
            gatewayReferenceId: gatewayResult.gatewayReferenceId,
          },
        });

        logStructured(this.logger, 'info', {
          event: 'payment.process.completed',
          requestId: ctx?.requestId,
          paymentId: payment.id,
          metadata: {
            outcome: 'success',
            attemptNumber: attempt.attemptNumber,
            terminalStatus: updated.status,
          },
        });

        return {
          payment: updated,
          outcome: 'success',
          attemptNumber: attempt.attemptNumber,
        };
      }

      const updated = await this.repository.finalizeProcessingFailure({
        paymentId: payment.id,
        attemptId: attempt.id,
        gatewayReferenceId: gatewayResult.gatewayReferenceId,
        gatewayResponse: {
          outcome: 'failure',
          gatewayReferenceId: gatewayResult.gatewayReferenceId,
          failureReason: gatewayResult.failureReason,
        },
        errorMessage: gatewayResult.failureReason,
      });

      logStructured(this.logger, 'warn', {
        event: 'payment.state.transition',
        requestId: ctx?.requestId,
        paymentId: payment.id,
        metadata: {
          trigger: 'gateway_sync_failure',
          toStatus: updated.status,
          attemptNumber: attempt.attemptNumber,
          gatewayOutcome: 'failure',
        },
      });

      logStructured(this.logger, 'warn', {
        event: 'payment.process.gateway_failure',
        requestId: ctx?.requestId,
        paymentId: payment.id,
        metadata: {
          attemptNumber: attempt.attemptNumber,
          failureReason: gatewayResult.failureReason,
          terminalStatus: updated.status,
        },
      });

      if (updated.status === 'Success') {
        logStructured(this.logger, 'info', {
          event: 'payment.process.completed',
          requestId: ctx?.requestId,
          paymentId: payment.id,
          metadata: {
            outcome: 'success',
            note: 'race_resolved_success',
            attemptNumber: attempt.attemptNumber,
          },
        });
        return {
          payment: updated,
          outcome: 'success',
          attemptNumber: attempt.attemptNumber,
        };
      }

      await this.maybeScheduleRetryAfterFailure(updated, ctx);

      logStructured(this.logger, 'info', {
        event: 'payment.process.completed',
        requestId: ctx?.requestId,
        paymentId: payment.id,
        metadata: {
          outcome: 'failure',
          attemptNumber: attempt.attemptNumber,
          terminalStatus: updated.status,
        },
      });

      return {
        payment: updated,
        outcome: 'failure',
        attemptNumber: attempt.attemptNumber,
      };
    } catch (error) {
      if (error instanceof GatewayTimeoutError) {
        logStructured(this.logger, 'warn', {
          event: 'payment.process.gateway_timeout',
          requestId: ctx?.requestId,
          paymentId: payment.id,
          metadata: { attemptNumber: attempt.attemptNumber },
        });

        const updated = await this.repository.finalizeProcessingFailure({
          paymentId: payment.id,
          attemptId: attempt.id,
          errorMessage: 'gateway_timeout',
          gatewayResponse: { outcome: 'timeout' },
        });

        logStructured(this.logger, 'warn', {
          event: 'payment.state.transition',
          requestId: ctx?.requestId,
          paymentId: payment.id,
          metadata: {
            trigger: 'gateway_timeout',
            toStatus: updated.status,
            attemptNumber: attempt.attemptNumber,
          },
        });

        if (updated.status === 'Success') {
          logStructured(this.logger, 'info', {
            event: 'payment.process.completed',
            requestId: ctx?.requestId,
            paymentId: payment.id,
            metadata: {
              outcome: 'success',
              note: 'race_resolved_success',
              attemptNumber: attempt.attemptNumber,
            },
          });
          return {
            payment: updated,
            outcome: 'success',
            attemptNumber: attempt.attemptNumber,
          };
        }

        await this.maybeScheduleRetryAfterFailure(updated, ctx);

        logStructured(this.logger, 'info', {
          event: 'payment.process.completed',
          requestId: ctx?.requestId,
          paymentId: payment.id,
          metadata: {
            outcome: 'timeout',
            attemptNumber: attempt.attemptNumber,
            terminalStatus: updated.status,
          },
        });

        return {
          payment: updated,
          outcome: 'timeout',
          attemptNumber: attempt.attemptNumber,
        };
      }

      const errObj = error instanceof Error ? error : new Error(String(error));

      logStructured(this.logger, 'error', {
        event: 'payment.process.gateway_error',
        requestId: ctx?.requestId,
        paymentId: payment.id,
        err: errObj,
        metadata: { attemptNumber: attempt.attemptNumber },
      });

      const updated = await this.repository.finalizeProcessingFailure({
        paymentId: payment.id,
        attemptId: attempt.id,
        errorMessage: error instanceof Error ? error.message : 'gateway_error',
        gatewayResponse: { outcome: 'error' },
      });

      logStructured(this.logger, 'warn', {
        event: 'payment.state.transition',
        requestId: ctx?.requestId,
        paymentId: payment.id,
        metadata: {
          trigger: 'gateway_exception',
          toStatus: updated.status,
          attemptNumber: attempt.attemptNumber,
        },
      });

      if (updated.status === 'Success') {
        logStructured(this.logger, 'info', {
          event: 'payment.process.completed',
          requestId: ctx?.requestId,
          paymentId: payment.id,
          metadata: {
            outcome: 'success',
            note: 'race_resolved_success',
            attemptNumber: attempt.attemptNumber,
          },
        });
        return {
          payment: updated,
          outcome: 'success',
          attemptNumber: attempt.attemptNumber,
        };
      }

      await this.maybeScheduleRetryAfterFailure(updated, ctx);

      logStructured(this.logger, 'error', {
        event: 'payment.process.unrecoverable_after_failure',
        requestId: ctx?.requestId,
        paymentId: payment.id,
        err: errObj,
        metadata: {
          attemptNumber: attempt.attemptNumber,
          terminalStatus: updated.status,
        },
      });

      throw error;
    }
  }

  async handlePaymentWebhook(
    payload: PaymentWebhookBody,
    ctx?: PaymentLogContext,
  ): Promise<PaymentWebhookIngestResult> {
    logStructured(this.logger, 'info', {
      event: 'payment.webhook.received',
      requestId: ctx?.requestId,
      metadata: {
        gatewayReferenceId: payload.gatewayReferenceId,
        webhookStatus: payload.status,
      },
    });

    try {
      const result = await this.repository.ingestPaymentWebhook(payload);

      logStructured(this.logger, 'info', {
        event: 'payment.webhook.processed',
        requestId: ctx?.requestId,
        paymentId: result.payment?.id,
        metadata: {
          ingestOutcome: result.outcome,
          httpStatus: result.httpStatus,
          webhookEventId: result.webhookEventId,
          paymentStatus: result.payment?.status,
        },
      });

      if (result.outcome === 'ignored_failed_vs_success_conflict') {
        logStructured(this.logger, 'warn', {
          event: 'payment.webhook.ignored_conflict',
          requestId: ctx?.requestId,
          metadata: {
            gatewayReferenceId: payload.gatewayReferenceId,
            webhookStatus: payload.status,
          },
        });
      }

      if (
        result.payment &&
        result.outcome === 'applied_failed' &&
        shouldEnqueuePaymentRetry(result.payment)
      ) {
        await this.maybeScheduleRetryAfterFailure(result.payment, ctx);
      }

      return result;
    } catch (error) {
      logStructured(this.logger, 'error', {
        event: 'payment.webhook.persist_failed',
        requestId: ctx?.requestId,
        metadata: { gatewayReferenceId: payload.gatewayReferenceId },
        err: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }
}
