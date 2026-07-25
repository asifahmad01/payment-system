import type { Env } from '../../config/env';

export const PAYMENT_RETRY_QUEUE_NAME = 'payment-retry';

/** Stable BullMQ job id per payment for deduplication. */
export function paymentRetryJobId(paymentId: string): string {
  return `payment-retry:${paymentId}`;
}

export interface RetryTimingConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  exponentCap: number;
}

export function retryTimingFromEnv(env: Env): RetryTimingConfig {
  return {
    baseDelayMs: env.PAYMENT_RETRY_BASE_DELAY_MS,
    maxDelayMs: env.PAYMENT_RETRY_MAX_DELAY_MS,
    exponentCap: env.PAYMENT_RETRY_EXPONENT_CAP,
  };
}

/**
 * Exponential backoff from the first retry onward.
 * Uses current `retryCount` after a failed attempt (≥1).
 *
 * delay = min(maxDelay, baseDelay * 2^min(retryCount - 1, exponentCap))
 */
export function computeRetryDelayMs(retryCount: number, timing: RetryTimingConfig): number {
  const exponent = Math.min(Math.max(retryCount - 1, 0), timing.exponentCap);
  const raw = timing.baseDelayMs * 2 ** exponent;
  const clamped = Math.min(raw, timing.maxDelayMs);
  return Math.max(0, Math.round(clamped));
}

/** Retry via queue only when the payment row is still retryable (non-terminal). */
export function shouldEnqueuePaymentRetry(payment: {
  status: string;
  retryCount: number;
  maxRetries: number;
}): boolean {
  return payment.status === 'Pending' && payment.retryCount < payment.maxRetries;
}
