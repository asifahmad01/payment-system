import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import type { Env } from './config/env';
import type { PrismaClient } from '@prisma/client';
import type { IPaymentGateway } from './modules/payments/payment-gateway.port';
import { createFakeExternalGatewayFromEnv } from './modules/gateway/fake-external-gateway.service';
import { PaymentProcessingService } from './modules/payments/payment-processing.service';
import { bootstrapPaymentProcessing } from './composition/payment-processing.bootstrap';
import { errorMiddleware } from './middleware/error.middleware';
import { notFoundMiddleware } from './middleware/not-found.middleware';
import { requestCorrelationMiddleware } from './middleware/request-correlation.middleware';
import type { AppLogger } from './modules/common/logger';
import { HealthController } from './modules/health/health.controller';
import { HealthService } from './modules/health/health.service';
import { StubPaymentProcessor } from './modules/payments/payment.processor';
import { PaymentController } from './modules/payments/payment.controller';
import { PaymentService } from './modules/payments/payment.service';
import { PrismaPaymentRepository } from './modules/payments/payment.repository';
import { registerRoutes } from './routes';
import { createPrismaClient } from './infrastructure/database';
import { WebhookController } from './modules/webhooks/webhook.controller';
import { MetricsController } from './modules/metrics/metrics.controller';
import { MetricsService } from './modules/metrics/metrics.service';
import { setupSwaggerUi } from './swagger/setup-swagger';

export interface CreateAppOptions {
  env?: Env;
  prisma?: PrismaClient;
  logger?: AppLogger;
  paymentGateway?: IPaymentGateway;
  paymentProcessingService?: PaymentProcessingService;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const env = options.env;
  if (!env) {
    throw new Error('createApp requires env to be set');
  }

  const logger = options.logger;
  if (!logger) {
    throw new Error('createApp requires logger to be set');
  }

  const prisma = options.prisma ?? createPrismaClient();

  const app = express();

  app.disable('x-powered-by');

  const helmetMiddleware = helmet();
  app.use((req, res, next) => {
    if (req.path.startsWith('/api-docs')) {
      next();
      return;
    }
    helmetMiddleware(req, res, next);
  });

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(requestCorrelationMiddleware);
  setupSwaggerUi(app);

  app.use(
    pinoHttp({
      logger,
      autoLogging: true,
      genReqId: (req) => req.requestId ?? randomUUID(),
      customProps: (req) => ({ requestId: req.requestId }),
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  const healthService = new HealthService(prisma);
  const healthController = new HealthController(healthService);

  const paymentRepository = new PrismaPaymentRepository(prisma);
  const paymentProcessor = new StubPaymentProcessor();
  const paymentService = new PaymentService(paymentRepository, paymentProcessor, logger);

  const paymentProcessingService =
    options.paymentProcessingService ??
    bootstrapPaymentProcessing(env, prisma, logger, {
      gateway: options.paymentGateway ?? createFakeExternalGatewayFromEnv(env),
      startWorker: false,
    }).paymentProcessingService;

  const paymentController = new PaymentController(paymentService, paymentProcessingService);
  const webhookController = new WebhookController(paymentProcessingService);
  const metricsService = new MetricsService(prisma);
  const metricsController = new MetricsController(metricsService);

  app.use(
    registerRoutes({
      healthController,
      paymentController,
      webhookController,
      metricsController,
    }),
  );

  app.use(notFoundMiddleware);
  app.use(errorMiddleware(logger));

  return app;
}
