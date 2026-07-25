import type { Job } from 'bullmq';
import {
  schedulePaymentRetryJob,
  type RetryJobQueue,
} from '../../src/infrastructure/redis-payment-retry.scheduler';
import { paymentRetryJobId } from '../../src/modules/payments/payment-retry.policy';
import { createLogger } from '../../src/modules/common/logger';
import { testEnv } from '../helpers/test-env';

describe('schedulePaymentRetryJob', () => {
  const logger = createLogger(testEnv);

  function mockDelayedJob(): Pick<Job<{ paymentId: string }>, 'getState' | 'remove'> {
    return {
      getState: jest.fn().mockResolvedValue('delayed'),
      remove: jest.fn(),
    };
  }

  it('prevents duplicate retry jobs while one is already queued', async () => {
    const paymentId = 'pay_dup';
    const existing = mockDelayedJob();
    const queue: RetryJobQueue = {
      getJob: jest.fn().mockResolvedValue(existing),
      add: jest.fn(),
    };

    await schedulePaymentRetryJob(queue, { paymentId, delayMs: 5_000 }, logger);

    expect(queue.getJob).toHaveBeenCalledWith(paymentRetryJobId(paymentId));
    expect(existing.getState).toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('adds a delayed job when none exists', async () => {
    const queue: RetryJobQueue = {
      getJob: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    };

    await schedulePaymentRetryJob(queue, { paymentId: 'pay_new', delayMs: 7_000 }, logger);

    expect(queue.add).toHaveBeenCalledWith(
      'process-payment',
      { paymentId: 'pay_new' },
      expect.objectContaining({
        jobId: paymentRetryJobId('pay_new'),
        delay: 7_000,
      }),
    );
  });
});
