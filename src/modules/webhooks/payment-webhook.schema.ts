import { z } from 'zod';

export const paymentWebhookBodySchema = z.object({
  gatewayReferenceId: z.string().trim().min(1, 'gatewayReferenceId is required'),
  status: z.enum(['success', 'failed']),
  reason: z.string().optional(),
});

export type PaymentWebhookBody = z.infer<typeof paymentWebhookBodySchema>;
