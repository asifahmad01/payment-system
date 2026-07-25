import type { IPaymentRetryScheduler } from '../modules/payments/payment-retry.scheduler.port';

export class NoOpPaymentRetryScheduler implements IPaymentRetryScheduler {
  async scheduleRetry(): Promise<void> {
    return Promise.resolve();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
