import { Router } from 'express';
import { validateBody } from '../middleware/validate-request';
import { requireIdempotencyKey } from '../middleware/require-idempotency-key';
import type { HealthController } from '../modules/health/health.controller';
import type { PaymentController } from '../modules/payments/payment.controller';
import type { WebhookController } from '../modules/webhooks/webhook.controller';
import type { MetricsController } from '../modules/metrics/metrics.controller';
import { initiatePaymentBodySchema } from '../modules/payments/initiate-payment.schema';
import { paymentWebhookBodySchema } from '../modules/webhooks/payment-webhook.schema';

export interface RouteControllers {
  healthController: HealthController;
  paymentController: PaymentController;
  webhookController: WebhookController;
  metricsController: MetricsController;
}

export function registerRoutes({
  healthController,
  paymentController,
  webhookController,
  metricsController,
}: RouteControllers): Router {
  const router = Router();

  router.get('/health', healthController.getHealth);
  router.get('/metrics', metricsController.getMetrics);

  router.post(
    '/payments',
    requireIdempotencyKey,
    validateBody(initiatePaymentBodySchema),
    paymentController.initiate,
  );

  router.post('/payments/:id/process', paymentController.processPayment);

  router.get('/payments/:id', paymentController.getById);

  router.post(
    '/webhooks/payment',
    validateBody(paymentWebhookBodySchema),
    webhookController.handlePaymentWebhook,
  );

  return router;
}
