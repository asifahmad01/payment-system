export interface SchedulePaymentRetryParams {
  paymentId: string;
  delayMs: number;
}

export interface IPaymentRetryScheduler {
  scheduleRetry(params: SchedulePaymentRetryParams): Promise<void>;
  close(): Promise<void>;
}
