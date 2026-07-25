import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { createLogger } from '../../src/modules/common/logger';
import { createPaymentTestPrisma } from '../helpers/create-payment-test-prisma';
import { testEnv } from '../helpers/test-env';

describe('GET /metrics (integration)', () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  it('returns payment aggregates and echoes X-Request-Id', async () => {
    const app = createApp({
      env: testEnv,
      logger: createLogger(testEnv),
      prisma,
    });

    const customId = 'corr-integration-metrics-1';
    const empty = await request(app).get('/metrics').set('X-Request-Id', customId);

    expect(empty.status).toBe(200);
    expect(empty.headers['x-request-id']).toBe(customId);
    expect(empty.body.data).toMatchObject({
      totalPayments: 0,
      byStatus: {},
      retrySummary: {
        sumRetryCount: 0,
        avgRetryCount: 0,
        maxRetryCount: 0,
        pendingPaymentsWithRetries: 0,
      },
    });

    await request(app)
      .post('/payments')
      .set('Idempotency-Key', 'metrics-pay-1')
      .send({ amount: 5, currency: 'USD' });

    const filled = await request(app).get('/metrics');

    expect(filled.status).toBe(200);
    expect(filled.body.data.totalPayments).toBe(1);
    expect(filled.body.data.byStatus.Pending).toBe(1);
    expect(filled.body.data.retrySummary.sumRetryCount).toBe(0);
  });
});
