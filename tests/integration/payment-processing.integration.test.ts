import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { GatewayTimeoutError } from '../../src/modules/common/errors';
import type { IPaymentGateway } from '../../src/modules/payments/payment-gateway.port';
import { createApp } from '../../src/app';
import { createLogger } from '../../src/modules/common/logger';
import { createPaymentTestPrisma } from '../helpers/create-payment-test-prisma';
import { testEnv } from '../helpers/test-env';

async function createPendingPayment(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app)
    .post('/payments')
    .set('Idempotency-Key', `proc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ amount: 10, currency: 'USD' });

  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('POST /payments/:id/process (integration, mocked persistence)', () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  it('successfully processes a pending payment through the gateway', async () => {
    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockResolvedValue({
        outcome: 'success',
        gatewayReferenceId: 'gw_ok_integration',
      }),
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    const res = await request(app).post(`/payments/${id}/process`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('success');
    expect(res.body.data.attemptNumber).toBe(1);
    expect(res.body.data.payment.status).toBe('Success');
    expect(res.body.data.payment.gatewayReferenceId).toBe('gw_ok_integration');
    expect(gateway.processPayment).toHaveBeenCalledTimes(1);
    expect(gateway.processPayment).toHaveBeenCalledWith({
      id,
      amount: '10',
      currency: 'USD',
    });
  });

  it('records gateway failure, increments retries, and keeps payment retryable', async () => {
    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockResolvedValue({
        outcome: 'failure',
        gatewayReferenceId: 'gw_declined',
        failureReason: 'simulated_gateway_decline',
      }),
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    const res = await request(app).post(`/payments/${id}/process`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('failure');
    expect(res.body.data.payment.retryCount).toBe(1);
    expect(res.body.data.payment.status).toBe('Pending');
    expect(res.body.data.payment.failureReason).toBe('simulated_gateway_decline');
    expect(gateway.processPayment).toHaveBeenCalledTimes(1);
  });

  it('treats gateway timeout like failure with timeout reason', async () => {
    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockRejectedValue(new GatewayTimeoutError()),
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    const res = await request(app).post(`/payments/${id}/process`).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('timeout');
    expect(res.body.data.payment.retryCount).toBe(1);
    expect(res.body.data.payment.failureReason).toBe('gateway_timeout');
    expect(res.body.data.payment.status).toBe('Pending');
    expect(gateway.processPayment).toHaveBeenCalledTimes(1);
  });

  it('does not re-invoke the gateway when payment is already successful', async () => {
    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockResolvedValue({
        outcome: 'success',
        gatewayReferenceId: 'gw_once',
      }),
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    const first = await request(app).post(`/payments/${id}/process`).send({});
    expect(first.body.data.outcome).toBe('success');

    const second = await request(app).post(`/payments/${id}/process`).send({});
    expect(second.body.data.outcome).toBe('skipped_already_success');
    expect(second.body.data.payment.status).toBe('Success');
    expect(gateway.processPayment).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an unknown payment id', async () => {
    const gateway: IPaymentGateway = {
      processPayment: jest.fn(),
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const res = await request(app).post('/payments/nonexistent_pay_id/process').send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(gateway.processPayment).not.toHaveBeenCalled();
  });

  it('allows reprocessing a payment that failed but has retries remaining', async () => {
    let callCount = 0;
    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            outcome: 'failure' as const,
            gatewayReferenceId: 'gw_retry_fail',
            failureReason: 'temporary_decline',
          };
        }
        return { outcome: 'success' as const, gatewayReferenceId: 'gw_retry_ok' };
      }),
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    const first = await request(app).post(`/payments/${id}/process`).send({});
    expect(first.status).toBe(200);
    expect(first.body.data.outcome).toBe('failure');
    expect(first.body.data.payment.status).toBe('Pending');
    expect(first.body.data.payment.retryCount).toBe(1);

    const second = await request(app).post(`/payments/${id}/process`).send({});
    expect(second.status).toBe(200);
    expect(second.body.data.outcome).toBe('success');
    expect(second.body.data.payment.status).toBe('Success');
    expect(gateway.processPayment).toHaveBeenCalledTimes(2);
  });

  it('returns skipped_terminal_failed when payment has exhausted all retries', async () => {
    const gateway: IPaymentGateway = {
      processPayment: jest.fn().mockResolvedValue({
        outcome: 'failure' as const,
        gatewayReferenceId: 'gw_terminal_fail',
        failureReason: 'card_declined',
      }),
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    // maxRetries defaults to 5; each failure increments retryCount until 5 >= 5 → terminal Failed
    for (let i = 0; i < 5; i++) {
      const interim = await request(app).post(`/payments/${id}/process`).send({});
      expect(interim.status).toBe(200);
    }

    const final = await request(app).post(`/payments/${id}/process`).send({});
    expect(final.status).toBe(200);
    expect(final.body.data.outcome).toBe('skipped_terminal_failed');
    expect(final.body.data.payment.status).toBe('Failed');
    expect(final.body.data.payment.retryCount).toBe(5);
    expect(gateway.processPayment).toHaveBeenCalledTimes(5);
  });

  it('serializes concurrent processors so the gateway runs once', async () => {
    const gwMock = jest.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return { outcome: 'success' as const, gatewayReferenceId: 'gw_parallel' };
    });

    const gateway: IPaymentGateway = {
      processPayment: gwMock,
    };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    const [r1, r2] = await Promise.all([
      request(app).post(`/payments/${id}/process`).send({}),
      request(app).post(`/payments/${id}/process`).send({}),
    ]);

    expect(gwMock).toHaveBeenCalledTimes(1);
    expect(prisma.paymentAttempt.create).toHaveBeenCalledTimes(1);
    expect([r1.body.data.outcome, r2.body.data.outcome].sort()).toEqual(['skipped_busy', 'success']);
  });
});
