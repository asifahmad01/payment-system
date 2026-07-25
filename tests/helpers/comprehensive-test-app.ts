import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import type { AppLogger } from '../../src/modules/common/logger';
import { createLogger } from '../../src/modules/common/logger';
import type { IPaymentGateway } from '../../src/modules/payments/payment-gateway.port';
import { PaymentProcessingRepository } from '../../src/modules/payments/payment-processing.repository';
import { PaymentProcessingService } from '../../src/modules/payments/payment-processing.service';
import type { RetryTimingConfig } from '../../src/modules/payments/payment-retry.policy';
import type { Env } from '../../src/config/env';
import { RecordingPaymentRetryScheduler } from './recording-payment-retry.scheduler';

/** HTTP app wired with an in-memory recording retry scheduler (no Redis). */
export function createAppWithRecordingRetryScheduler(
  env: Env,
  prisma: PrismaClient,
  gateway: IPaymentGateway,
  retryTiming: RetryTimingConfig,
  logger: AppLogger = createLogger(env),
): {
  app: ReturnType<typeof createApp>;
  scheduler: RecordingPaymentRetryScheduler;
} {
  const repository = new PaymentProcessingRepository(prisma as unknown as PrismaClient);
  const scheduler = new RecordingPaymentRetryScheduler();
  const processing = new PaymentProcessingService(
    repository,
    gateway,
    logger,
    scheduler,
    retryTiming,
  );
  const app = createApp({
    env,
    logger,
    prisma,
    paymentProcessingService: processing,
  });
  return { app, scheduler };
}
