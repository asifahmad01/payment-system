import type { Queue } from 'bullmq';
import type { AppLogger } from '../modules/common/logger';
import { logStructured } from '../modules/common/structured-log';
import {
  PAYMENT_RETRY_QUEUE_NAME,
  paymentRetryJobId,
} from '../modules/payments/payment-retry.policy';
import type {
  IPaymentRetryScheduler,
  SchedulePaymentRetryParams,
} from '../modules/payments/payment-retry.scheduler.port';

export type RetryJobPayload = { paymentId: string };

/** Narrow queue surface so BullMQ can be substituted in tests. */
export type RetryJobQueue = Pick<Queue<RetryJobPayload>, 'add' | 'getJob'>;

const ACTIVE_RETRY_STATES = new Set(['delayed', 'waiting', 'paused']);

/**
 * Enqueues (or preserves) a delayed retry job with stable `jobId` so duplicate
 * schedules for the same payment are ignored while a job is already queued.
 */
export async function schedulePaymentRetryJob(
  queue: RetryJobQueue,
  params: SchedulePaymentRetryParams,
  logger: AppLogger,
): Promise<void> {
  const jobId = paymentRetryJobId(params.paymentId);
  const existing = await queue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (ACTIVE_RETRY_STATES.has(state)) {
      logStructured(logger, 'info', {
        event: 'payment.retry.duplicate_schedule_skipped',
        paymentId: params.paymentId,
        metadata: { jobId, queueState: state },
      });
      return;
    }
    await existing.remove().catch(() => undefined);
  }

  await queue.add(
    'process-payment',
    { paymentId: params.paymentId },
    { jobId, delay: params.delayMs },
  );

  logStructured(logger, 'info', {
    event: 'payment.retry.job_enqueued',
    paymentId: params.paymentId,
    metadata: { delayMs: params.delayMs, jobId, queue: PAYMENT_RETRY_QUEUE_NAME },
  });
}

export class RedisPaymentRetryScheduler implements IPaymentRetryScheduler {
  constructor(
    private readonly queue: Queue<RetryJobPayload>,
    private readonly logger: AppLogger,
  ) {}

  scheduleRetry(params: SchedulePaymentRetryParams): Promise<void> {
    return schedulePaymentRetryJob(this.queue, params, this.logger);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
