import type { Job, Worker } from 'bullmq';
import { Worker as BullWorker } from 'bullmq';
import type { AppLogger } from '../modules/common/logger';
import { logStructured } from '../modules/common/structured-log';
import { PAYMENT_RETRY_QUEUE_NAME } from '../modules/payments/payment-retry.policy';
import type { RetryJobPayload } from '../infrastructure/redis-payment-retry.scheduler';
import type { PaymentProcessingService } from '../modules/payments/payment-processing.service';

export function createPaymentRetryWorker(
  redisUrl: string,
  logger: AppLogger,
  processingService: PaymentProcessingService,
): Worker<RetryJobPayload> {
  return new BullWorker<RetryJobPayload>(
    PAYMENT_RETRY_QUEUE_NAME,
    async (job: Job<RetryJobPayload>) => {
      logStructured(logger, 'debug', {
        event: 'payment.retry.worker_job_started',
        paymentId: job.data.paymentId,
        metadata: { bullJobId: job.id },
      });
      await processingService.processPaymentById(job.data.paymentId);
    },
    {
      connection: { url: redisUrl },
      concurrency: 5,
    },
  );
}
