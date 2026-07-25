import type {
  IPaymentRetryScheduler,
  SchedulePaymentRetryParams,
} from '../../src/modules/payments/payment-retry.scheduler.port';

/** Captures `scheduleRetry` calls for assertions (inject instead of Redis). */
export class RecordingPaymentRetryScheduler implements IPaymentRetryScheduler {
  readonly calls: SchedulePaymentRetryParams[] = [];

  async scheduleRetry(params: SchedulePaymentRetryParams): Promise<void> {
    this.calls.push(params);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
