import type { PrismaClient } from '@prisma/client';
import type { Worker } from 'bullmq';
import { Queue } from 'bullmq';
import type { Env } from '../config/env';
import type { AppLogger } from '../modules/common/logger';
import { createFakeExternalGatewayFromEnv } from '../modules/gateway/fake-external-gateway.service';
import { PaymentProcessingRepository } from '../modules/payments/payment-processing.repository';
import { PaymentProcessingService } from '../modules/payments/payment-processing.service';
import type { IPaymentGateway } from '../modules/payments/payment-gateway.port';
import type { IPaymentRetryScheduler } from '../modules/payments/payment-retry.scheduler.port';
import {
  PAYMENT_RETRY_QUEUE_NAME,
  retryTimingFromEnv,
} from '../modules/payments/payment-retry.policy';
import type { RetryJobPayload } from '../infrastructure/redis-payment-retry.scheduler';
import { RedisPaymentRetryScheduler } from '../infrastructure/redis-payment-retry.scheduler';
import { NoOpPaymentRetryScheduler } from '../infrastructure/no-op-payment-retry.scheduler';
import { createPaymentRetryWorker } from '../workers/payment-retry.worker';
import { PaymentRecoveryService } from '../modules/payments/payment-recovery.service';

export interface PaymentProcessingBootstrap {
  paymentProcessingService: PaymentProcessingService;
  paymentRetryScheduler: IPaymentRetryScheduler;
  retryWorker: Worker<RetryJobPayload> | null;
  paymentRecoveryService: PaymentRecoveryService;
}

export interface BootstrapPaymentProcessingOptions {
  gateway?: IPaymentGateway;
  /** When true with Redis configured, attaches a BullMQ worker in-process. */
  startWorker?: boolean;
}

export function bootstrapPaymentProcessing(
  env: Env,
  prisma: PrismaClient,
  logger: AppLogger,
  options: BootstrapPaymentProcessingOptions = {},
): PaymentProcessingBootstrap {
  const paymentGateway = options.gateway ?? createFakeExternalGatewayFromEnv(env);
  const repository = new PaymentProcessingRepository(prisma);
  const retryTiming = retryTimingFromEnv(env);

  const buildRecoveryService = (
    scheduler: IPaymentRetryScheduler,
  ): PaymentRecoveryService =>
    new PaymentRecoveryService(repository, paymentGateway, logger, scheduler, retryTiming, {
      enabled: env.PAYMENT_RECOVERY_ENABLED,
      intervalMs: env.PAYMENT_RECOVERY_INTERVAL_MS,
      minIdleAfterLeaseMs: env.PAYMENT_RECOVERY_MIN_IDLE_AFTER_LEASE_MS,
      batchSize: env.PAYMENT_RECOVERY_BATCH_SIZE,
    });

  const redisRetries = Boolean(env.PAYMENT_RETRY_ENABLED && env.REDIS_URL);

  let scheduler: IPaymentRetryScheduler;
  let retryWorker: Worker<RetryJobPayload> | null = null;

  if (redisRetries) {
    const redisUrl = env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL is required when PAYMENT_RETRY_ENABLED is true');
    }

    const queue = new Queue<RetryJobPayload>(PAYMENT_RETRY_QUEUE_NAME, {
      connection: { url: redisUrl },
    });
    scheduler = new RedisPaymentRetryScheduler(queue, logger);

    const processingService = new PaymentProcessingService(
      repository,
      paymentGateway,
      logger,
      scheduler,
      retryTiming,
    );

    if (options.startWorker) {
      retryWorker = createPaymentRetryWorker(redisUrl, logger, processingService);
    }

    const paymentRecoveryService = buildRecoveryService(scheduler);

    return {
      paymentProcessingService: processingService,
      paymentRetryScheduler: scheduler,
      retryWorker,
      paymentRecoveryService,
    };
  }

  scheduler = new NoOpPaymentRetryScheduler();
  const processingService = new PaymentProcessingService(
    repository,
    paymentGateway,
    logger,
    scheduler,
    retryTiming,
  );

  const paymentRecoveryService = buildRecoveryService(scheduler);

  return {
    paymentProcessingService: processingService,
    paymentRetryScheduler: scheduler,
    retryWorker,
    paymentRecoveryService,
  };
}
