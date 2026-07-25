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
    .set('Idempotency-Key', `wh-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ amount: 10, currency: 'USD' });

  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('POST /webhooks/payment (async gateway callbacks)', () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  it('applies a valid success callback when payment is in-flight with gateway reference', async () => {
    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });
    const paymentId = await createPendingPayment(app);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'Processing',
        gatewayReferenceId: 'gw_valid_ok',
        lockedUntil: new Date(Date.now() + 120_000),
      },
    });

    await prisma.paymentAttempt.create({
      data: {
        paymentId,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    const res = await request(app).post('/webhooks/payment').send({
      gatewayReferenceId: 'gw_valid_ok',
      status: 'success',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('applied_success');
    expect(res.body.data.payment.status).toBe('Success');
    expect(prisma.webhookEvent.create).toHaveBeenCalled();

    const stored = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(stored?.status).toBe('Success');
  });

  it('stores duplicate callbacks idempotently without corrupting terminal Success', async () => {
    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });
    const paymentId = await createPendingPayment(app);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'Processing',
        gatewayReferenceId: 'gw_dup_twice',
        lockedUntil: new Date(Date.now() + 120_000),
      },
    });

    await prisma.paymentAttempt.create({
      data: {
        paymentId,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    const first = await request(app).post('/webhooks/payment').send({
      gatewayReferenceId: 'gw_dup_twice',
      status: 'success',
    });

    const second = await request(app).post('/webhooks/payment').send({
      gatewayReferenceId: 'gw_dup_twice',
      status: 'success',
    });

    expect(first.status).toBe(200);
    expect(first.body.data.outcome).toBe('applied_success');
    expect(second.status).toBe(200);
    expect(second.body.data.outcome).toBe('already_success');
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);

    const pay = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(pay?.status).toBe('Success');
  });

  it('queues early success webhooks then applies them after gateway reference is attached', async () => {
    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });
    const paymentId = await createPendingPayment(app);

    const early = await request(app).post('/webhooks/payment').send({
      gatewayReferenceId: 'gw_early_then_attach',
      status: 'success',
    });

    expect(early.status).toBe(202);
    expect(early.body.data.outcome).toBe('queued_early_no_payment');

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'Processing',
        lockedUntil: new Date(Date.now() + 120_000),
      },
    });

    await prisma.paymentAttempt.create({
      data: {
        paymentId,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    const repo = new PaymentProcessingRepository(prisma as unknown as PrismaClient);
    await repo.attachGatewayReferenceForProcessingPayment(paymentId, 'gw_early_then_attach');

    const stored = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(stored?.status).toBe('Success');
    expect(stored?.gatewayReferenceId).toBe('gw_early_then_attach');

    const events = await prisma.webhookEvent.findMany({
      where: { gatewayReferenceId: 'gw_early_then_attach' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.length).toBe(1);
    expect(events[0]?.processed).toBe(true);
  });

  it('ignores failed callbacks after Success and logs a conflict', async () => {
    const logger = createLogger(testEnv);
    const warnSpy = jest.spyOn(logger, 'warn');

    const app = createApp({ env: testEnv, logger, prisma });
    const paymentId = await createPendingPayment(app);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'Success',
        gatewayReferenceId: 'gw_conflict',
      },
    });

    const res = await request(app).post('/webhooks/payment').send({
      gatewayReferenceId: 'gw_conflict',
      status: 'failed',
      reason: 'issuer_declined',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('ignored_failed_vs_success_conflict');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'payment.webhook.ignored_conflict',
        metadata: expect.objectContaining({
          gatewayReferenceId: 'gw_conflict',
          webhookStatus: 'failed',
        }),
      }),
    );

    warnSpy.mockRestore();

    const pay = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(pay?.status).toBe('Success');
  });

  it('accepts unknown gateway references without payment rows (queued for later correlation)', async () => {
    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });

    const res = await request(app).post('/webhooks/payment').send({
      gatewayReferenceId: 'gw_unknown_forever',
      status: 'success',
    });

    expect(res.status).toBe(202);
    expect(res.body.data.outcome).toBe('queued_early_no_payment');

    const events = await prisma.webhookEvent.findMany({
      where: { gatewayReferenceId: 'gw_unknown_forever' },
    });
    expect(events.length).toBe(1);
    expect(events[0]?.processed).toBe(false);
  });

  it('recovers Failed payment to Success when gateway sends success', async () => {
    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });
    const paymentId = await createPendingPayment(app);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'Failed',
        gatewayReferenceId: 'gw_recover',
        failureReason: 'prior_decline',
      },
    });

    const res = await request(app).post('/webhooks/payment').send({
      gatewayReferenceId: 'gw_recover',
      status: 'success',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('applied_success_recovered_from_failed');
    expect(res.body.data.payment.status).toBe('Success');

    const pay = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(pay?.status).toBe('Success');
    expect(pay?.failureReason).toBeNull();
  });
});
