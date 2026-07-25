import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { createLogger } from '../../src/modules/common/logger';
import { PaymentProcessingRepository } from '../../src/modules/payments/payment-processing.repository';
import { createPaymentTestPrisma } from '../helpers/create-payment-test-prisma';
import { testEnv } from '../helpers/test-env';

async function createPendingPayment(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app)
    .post('/payments')
    .set('Idempotency-Key', `conc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ amount: 10, currency: 'USD' });

  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('payment concurrency controls (integration, mocked persistence)', () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  it('serializes concurrent processPayment calls — single gateway invocation and single attempt row', async () => {
    const gwMock = jest.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return { outcome: 'success' as const, gatewayReferenceId: 'gw_one_winner' };
    });

    const gateway = { processPayment: gwMock };

    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
      paymentGateway: gateway,
    });

    const id = await createPendingPayment(app);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post(`/payments/${id}/process`).send({})),
    );

    expect(gwMock).toHaveBeenCalledTimes(1);
    expect(prisma.paymentAttempt.create).toHaveBeenCalledTimes(1);

    const successes = responses.filter((r) => r.body?.data?.outcome === 'success');
    const skippedBusy = responses.filter((r) => r.body?.data?.outcome === 'skipped_busy');
    expect(successes).toHaveLength(1);
    expect(skippedBusy).toHaveLength(7);
  });

  it('concurrent initiate requests with the same idempotency key persist exactly one payment', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const key = `idem-race-${Date.now()}`;
    const payload = { amount: 7, currency: 'USD' };

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).post('/payments').set('Idempotency-Key', key).send(payload),
      ),
    );

    const ids = new Set(responses.map((r) => r.body?.data?.id));
    expect(ids.size).toBe(1);

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);

    const created = responses.filter((r) => r.status === 201);
    const replayed = responses.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(11);
  });

  it('parallel webhook confirmation and processor finalize converge on terminal Success', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const paymentId = await createPendingPayment(app);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'Processing',
        gatewayReferenceId: 'gw_parallel_confirm',
        lockedUntil: new Date(Date.now() + 120_000),
      },
    });

    const attemptRow = await prisma.paymentAttempt.create({
      data: {
        paymentId,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    const repo = new PaymentProcessingRepository(prisma as unknown as PrismaClient);

    const [finalized, webhookIngest] = await Promise.all([
      repo.finalizeSuccess(paymentId, attemptRow.id, 'gw_parallel_confirm'),
      repo.ingestPaymentWebhook({
        gatewayReferenceId: 'gw_parallel_confirm',
        status: 'success',
      }),
    ]);

    expect(finalized.status).toBe('Success');

    expect(
      webhookIngest.outcome === 'applied_success' || webhookIngest.outcome === 'already_success',
    ).toBe(true);
    expect(webhookIngest.payment?.status).toBe('Success');

    const stored = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(stored?.status).toBe('Success');

    const attempt = await prisma.paymentAttempt.findUnique({ where: { id: attemptRow.id } });
    expect(attempt?.status).toBe('Success');
  });
});
