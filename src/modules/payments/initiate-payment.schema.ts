import { z } from 'zod';

export const initiatePaymentBodySchema = z.object({
  amount: z.number().finite().positive({
    message: 'amount must be greater than 0',
  }),
  currency: z
    .string()
    .trim()
    .min(1, 'currency must be non-empty')
    .max(3, 'currency must be at most 3 characters'),
});

export type InitiatePaymentBody = z.infer<typeof initiatePaymentBodySchema>;
