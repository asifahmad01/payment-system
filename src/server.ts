import { createServer } from 'node:http';
import { getEnv } from './config/env';
import { createLogger } from './modules/common/logger';
import { createApp } from './app';
import { getPrismaSingleton } from './infrastructure/database';
import { bootstrapPaymentProcessing } from './composition/payment-processing.bootstrap';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const logger = createLogger(env);
  const prisma = getPrismaSingleton();

  const processingStack = bootstrapPaymentProcessing(env, prisma, logger, { startWorker: true });

  const app = createApp({
    env,
    prisma,
    logger,
    paymentProcessingService: processingStack.paymentProcessingService,
  });
  const server = createServer(app);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'HTTP server listening');
  });

  processingStack.paymentRecoveryService.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    processingStack.paymentRecoveryService.stop();
    server.close(async () => {
      try {
        await processingStack.retryWorker?.close();
        await processingStack.paymentRetryScheduler.close();
      } catch (error: unknown) {
        logger.error({ err: error }, 'Payment retry worker/scheduler close failed');
      }
      try {
        await prisma.$disconnect();
      } catch (error: unknown) {
        logger.error({ err: error }, 'Prisma disconnect failed');
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();
