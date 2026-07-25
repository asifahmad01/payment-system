import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { createLogger } from '../../src/modules/common/logger';
import { createPaymentTestPrisma } from '../helpers/create-payment-test-prisma';
import { testEnv } from '../helpers/test-env';

describe('POST /payments (integration, mocked persistence)', () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  it('creates a new payment with Pending status', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'integration-new-1')
      .send({ amount: 12.34, currency: 'USD' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'Pending',
      currency: 'USD',
      amount: '12.34',
      idempotencyKey: 'integration-new-1',
    });
    expect(typeof res.body.data.id).toBe('string');

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
  });

  it('returns the same payment with 200 when idempotency key repeats', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const payload = { amount: 9.99, currency: 'EUR' };

    const first = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'integration-idem-2')
      .send(payload);

    const second = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'integration-idem-2')
      .send({ amount: 999, currency: 'GBP' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.amount).toBe(first.body.data.amount);
    expect(second.body.data.currency).toBe(first.body.data.currency);

    const count = await prisma.payment.count({ where: { idempotencyKey: 'integration-idem-2' } });
    expect(count).toBe(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when Idempotency-Key is missing', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const res = await request(app).post('/payments').send({ amount: 1, currency: 'USD' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('returns 422 when amount is not greater than zero', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const res = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'integration-invalid-amt')
      .send({ amount: 0, currency: 'USD' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('concurrent duplicate requests yield a single persisted payment id', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const key = `integration-concurrent-${Date.now()}`;
    const payload = { amount: 3, currency: 'USD' };

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).post('/payments').set('Idempotency-Key', key).send(payload),
      ),
    );

    const ids = [...new Set(responses.map((r) => r.body?.data?.id).filter(Boolean))];
    expect(ids).toHaveLength(1);
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);

    const count = await prisma.payment.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });
});

describe('GET /payments/:id (integration, mocked persistence)', () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  it('returns payment details including status and retry metadata', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const created = await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'get-payment-1')
      .send({ amount: 42.12, currency: 'USD' });

    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const res = await request(app).get(`/payments/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id,
      idempotencyKey: 'get-payment-1',
      amount: '42.12',
      currency: 'USD',
      status: 'Pending',
      gatewayReferenceId: null,
      retryCount: 0,
      maxRetries: 5,
      failureReason: null,
      lockedUntil: null,
      createdAt: created.body.data.createdAt,
      updatedAt: created.body.data.updatedAt,
    });
    expect(prisma.payment.findUnique).toHaveBeenCalled();
  });

  it('returns 404 when payment does not exist', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const res = await request(app).get('/payments/pay_no_such_row');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('pay_no_such_row'),
    });
  });
});
