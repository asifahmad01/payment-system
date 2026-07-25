import type { Payment } from './payment.types';

/** Stable JSON shape for payment resources (Decimal → string). */
export function paymentToDto(payment: Payment) {
  return {
    id: payment.id,
    idempotencyKey: payment.idempotencyKey,
    amount: payment.amount.toString(),
    currency: payment.currency.trim(),
    status: payment.status,
    gatewayReferenceId: payment.gatewayReferenceId,
    retryCount: payment.retryCount,
    maxRetries: payment.maxRetries,
    failureReason: payment.failureReason,
    lockedUntil: payment.lockedUntil?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}
