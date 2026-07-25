import {
  computeRetryDelayMs,
  shouldEnqueuePaymentRetry,
  type RetryTimingConfig,
} from '../../src/modules/payments/payment-retry.policy';

describe('payment-retry.policy', () => {
  const timing: RetryTimingConfig = {
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    exponentCap: 4,
  };

  describe('computeRetryDelayMs', () => {
    it('uses exponential backoff from the first completed failure (retryCount 1 → exponent 0)', () => {
      expect(computeRetryDelayMs(1, timing)).toBe(1_000);
    });

    it('doubles delay for each additional retry until the exponent cap', () => {
      expect(computeRetryDelayMs(2, timing)).toBe(2_000);
      expect(computeRetryDelayMs(3, timing)).toBe(4_000);
      expect(computeRetryDelayMs(4, timing)).toBe(8_000);
      expect(computeRetryDelayMs(5, timing)).toBe(16_000);
      expect(computeRetryDelayMs(6, timing)).toBe(16_000);
    });

    it('clamps delay at maxDelayMs', () => {
      const shortCap: RetryTimingConfig = {
        baseDelayMs: 50_000,
        maxDelayMs: 55_000,
        exponentCap: 10,
      };
      expect(computeRetryDelayMs(5, shortCap)).toBe(55_000);
    });
  });

  describe('shouldEnqueuePaymentRetry', () => {
    it('allows enqueue only for Pending payments under maxRetries', () => {
      expect(
        shouldEnqueuePaymentRetry({ status: 'Pending', retryCount: 2, maxRetries: 5 }),
      ).toBe(true);
      expect(
        shouldEnqueuePaymentRetry({ status: 'Success', retryCount: 2, maxRetries: 5 }),
      ).toBe(false);
      expect(
        shouldEnqueuePaymentRetry({ status: 'Failed', retryCount: 5, maxRetries: 5 }),
      ).toBe(false);
      expect(
        shouldEnqueuePaymentRetry({ status: 'Pending', retryCount: 5, maxRetries: 5 }),
      ).toBe(false);
    });
  });
});
