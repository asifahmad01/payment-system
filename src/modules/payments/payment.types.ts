export type {
  Payment,
  PaymentAttempt,
  PaymentAttemptStatus,
  PaymentStatus,
  WebhookEvent,
} from '@prisma/client';

/** Input for initiating a payment before persistence (service layer maps to Prisma types). */
export interface CreatePaymentInput {
  idempotencyKey: string;
  /** Monetary amount as decimal string or number; persisted as `Decimal(18, 4)`. */
  amount: string | number;
  /** ISO 4217 alphabetic code (3 letters). */
  currency: string;
  metadata?: Record<string, string>;
}
