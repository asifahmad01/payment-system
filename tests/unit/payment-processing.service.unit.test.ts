import { Prisma } from '@prisma/client';
import { GatewayTimeoutError } from '../../src/modules/common/errors';
import type { IPaymentGateway } from '../../src/modules/payments/payment-gateway.port';
import { PaymentProcessingRepository } from '../../src/modules/payments/payment-processing.repository';
import { PaymentProcessingService } from '../../src/modules/payments/payment-processing.service';
import {
  computeRetryDelayMs,
  type RetryTimingConfig,
} from '../../src/modules/payments/payment-retry.policy';
import type { Payment } from '../../src/modules/payments/payment.types';
import { createLogger } from '../../src/modules/common/logger';
import { RecordingPaymentRetryScheduler } from '../helpers/recording-payment-retry.scheduler';

function mockPayment(overrides: Partial<Payment> & Pick<Payment, 'id'>): Payment {
  const now = new Date();
  return {
    idempotencyKey: 'idem-1',
    amount: new Prisma.Decimal('10.00'),
    currency: 'USD',
    gatewayReferenceId: null,
    retryCount: 0,
    maxRetries: 5,
    failureReason: null,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
    status: 'Pending',
    ...overrides,
  };
}

describe('PaymentProcessingService (retry scheduling)', () => {
  const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
  const retryTiming: RetryTimingConfig = {
    baseDelayMs: 2_000,
    maxDelayMs: 120_000,
    exponentCap: 10,
  };

  type RepoPick = Pick<
    PaymentProcessingRepository,
    | 'claimPaymentForProcessing'
    | 'attachGatewayReferenceForProcessingPayment'
    | 'finalizeSuccess'
    | 'finalizeProcessingFailure'
  >;

  it('schedules a retry after gateway failure when payment stays Pending', async () => {
    const paymentId = 'pay_fail';
    const scheduler = new RecordingPaymentRetryScheduler();
    const attempt = {
      id: 'att_1',
      paymentId,
      attemptNumber: 1,
      status: 'Processing' as const,
      completedAt: null,
      createdAt: new Date(),
      errorMessage: null,
      gatewayResponse: null,
    };

    const repo: jest.Mocked<RepoPick> = {
      claimPaymentForProcessing: jest.fn().mockResolvedValue({
        kind: 'claimed' as const,
        payment: mockPayment({ id: paymentId }),
        attempt,
      }),
      attachGatewayReferenceForProcessingPayment: jest.fn().mockResolvedValue(undefined),
      finalizeSuccess: jest.fn(),
      finalizeProcessingFailure: jest.fn().mockResolvedValue(
        mockPayment({ id: paymentId, retryCount: 1, status: 'Pending', failureReason: 'declined' }),
      ),
    };

    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockResolvedValue({
        outcome: 'failure',
        gatewayReferenceId: 'gw_x',
        failureReason: 'declined',
      }),
    };

    const service = new PaymentProcessingService(
      repo as unknown as PaymentProcessingRepository,
      gateway,
      logger,
      scheduler,
      retryTiming,
    );

    await service.processPaymentById(paymentId);

    expect(scheduler.calls).toEqual([
      {
        paymentId,
        delayMs: computeRetryDelayMs(1, retryTiming),
      },
    ]);
  });

  it('does not schedule retries after success', async () => {
    const paymentId = 'pay_ok';
    const scheduler = new RecordingPaymentRetryScheduler();
    const attempt = {
      id: 'att_1',
      paymentId,
      attemptNumber: 1,
      status: 'Processing' as const,
      completedAt: null,
      createdAt: new Date(),
      errorMessage: null,
      gatewayResponse: null,
    };

    const repo: jest.Mocked<RepoPick> = {
      claimPaymentForProcessing: jest.fn().mockResolvedValue({
        kind: 'claimed' as const,
        payment: mockPayment({ id: paymentId }),
        attempt,
      }),
      attachGatewayReferenceForProcessingPayment: jest.fn().mockResolvedValue(undefined),
      finalizeSuccess: jest.fn().mockResolvedValue(
        mockPayment({ id: paymentId, status: 'Success', gatewayReferenceId: 'gw_ok' }),
      ),
      finalizeProcessingFailure: jest.fn(),
    };

    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockResolvedValue({
        outcome: 'success',
        gatewayReferenceId: 'gw_ok',
      }),
    };

    const service = new PaymentProcessingService(
      repo as unknown as PaymentProcessingRepository,
      gateway,
      logger,
      scheduler,
      retryTiming,
    );

    await service.processPaymentById(paymentId);

    expect(repo.attachGatewayReferenceForProcessingPayment).toHaveBeenCalledWith(
      paymentId,
      'gw_ok',
    );
    expect(scheduler.calls).toHaveLength(0);
  });

  it('does not schedule retries when max retries marks payment Failed', async () => {
    const paymentId = 'pay_terminal';
    const scheduler = new RecordingPaymentRetryScheduler();
    const attempt = {
      id: 'att_5',
      paymentId,
      attemptNumber: 5,
      status: 'Processing' as const,
      completedAt: null,
      createdAt: new Date(),
      errorMessage: null,
      gatewayResponse: null,
    };

    const repo: jest.Mocked<RepoPick> = {
      claimPaymentForProcessing: jest.fn().mockResolvedValue({
        kind: 'claimed' as const,
        payment: mockPayment({ id: paymentId, retryCount: 4, maxRetries: 5 }),
        attempt,
      }),
      attachGatewayReferenceForProcessingPayment: jest.fn().mockResolvedValue(undefined),
      finalizeSuccess: jest.fn(),
      finalizeProcessingFailure: jest.fn().mockResolvedValue(
        mockPayment({
          id: paymentId,
          retryCount: 5,
          maxRetries: 5,
          status: 'Failed',
          failureReason: 'final_decline',
        }),
      ),
    };

    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockResolvedValue({
        outcome: 'failure',
        gatewayReferenceId: 'gw_final',
        failureReason: 'final_decline',
      }),
    };

    const service = new PaymentProcessingService(
      repo as unknown as PaymentProcessingRepository,
      gateway,
      logger,
      scheduler,
      retryTiming,
    );

    await service.processPaymentById(paymentId);

    expect(scheduler.calls).toHaveLength(0);
  });

  it('schedules retry after gateway timeout path', async () => {
    const paymentId = 'pay_to';
    const scheduler = new RecordingPaymentRetryScheduler();
    const attempt = {
      id: 'att_1',
      paymentId,
      attemptNumber: 1,
      status: 'Processing' as const,
      completedAt: null,
      createdAt: new Date(),
      errorMessage: null,
      gatewayResponse: null,
    };

    const repo: jest.Mocked<RepoPick> = {
      claimPaymentForProcessing: jest.fn().mockResolvedValue({
        kind: 'claimed' as const,
        payment: mockPayment({ id: paymentId }),
        attempt,
      }),
      attachGatewayReferenceForProcessingPayment: jest.fn().mockResolvedValue(undefined),
      finalizeSuccess: jest.fn(),
      finalizeProcessingFailure: jest.fn().mockResolvedValue(
        mockPayment({
          id: paymentId,
          retryCount: 1,
          status: 'Pending',
          failureReason: 'gateway_timeout',
        }),
      ),
    };

    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockRejectedValue(new GatewayTimeoutError()),
    };

    const service = new PaymentProcessingService(
      repo as unknown as PaymentProcessingRepository,
      gateway,
      logger,
      scheduler,
      retryTiming,
    );

    await service.processPaymentById(paymentId);

    expect(scheduler.calls).toEqual([
      { paymentId, delayMs: computeRetryDelayMs(1, retryTiming) },
    ]);
  });
});
