/**
 * End-to-end checklist for the payment processing system (deterministic mocks).
 * Covers initiation, idempotency, status, gateway outcomes, retries, concurrency,
 * webhooks, recovery, and validation — each scenario maps to product requirements.
 */
import request from 'supertest';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { GatewayTimeoutError } from '../../src/modules/common/errors';
import { createLogger } from '../../src/modules/common/logger';
import type { IPaymentGateway } from '../../src/modules/payments/payment-gateway.port';
import { PaymentProcessingRepository } from '../../src/modules/payments/payment-processing.repository';
import { PaymentRecoveryService } from '../../src/modules/payments/payment-recovery.service';
import {
  computeRetryDelayMs,
  retryTimingFromEnv,
  type RetryTimingConfig,
} from '../../src/modules/payments/payment-retry.policy';
import { createApp } from '../../src/app';
import { createPaymentTestPrisma } from '../helpers/create-payment-test-prisma';
import { createAppWithRecordingRetryScheduler } from '../helpers/comprehensive-test-app';
import { RecordingPaymentRetryScheduler } from '../helpers/recording-payment-retry.scheduler';
import { testEnv } from '../helpers/test-env';

const logger = createLogger(testEnv);

/** Fixed instant in the past — recovery treats lease as expired when minIdleAfterLeaseMs is 0. */
const EXPIRED_LEASE = new Date('2020-01-01T00:00:00.000Z');

async function postInitiate(
  app: ReturnType<typeof createApp>,
  idempotencyKey: string,
  body: { amount: number; currency: string } = { amount: 10, currency: 'USD' },
): Promise<{ status: number; id: string }> {
  const res = await request(app)
    .post('/payments')
    .set('Idempotency-Key', idempotencyKey)
    .send(body);

  const id = res.body?.data?.id as string | undefined;
  if (!id) {
    throw new Error(`Initiate failed: status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  return { status: res.status, id };
}

function failingGateway(reason = 'deterministic_decline'): IPaymentGateway {
  return {
    processPayment: jest.fn().mockResolvedValue({
      outcome: 'failure' as const,
      gatewayReferenceId: 'gw_fail_deterministic',
      failureReason: reason,
    }),
  };
}

function successGateway(ref = 'gw_success_deterministic'): IPaymentGateway {
  return {
    processPayment: jest.fn().mockResolvedValue({
      outcome: 'success' as const,
      gatewayReferenceId: ref,
    }),
  };
}

function recoveryGatewayProbe(): IPaymentGateway {
  return {
    processPayment: jest.fn(),
    getChargeStatus: jest.fn(async (gatewayReferenceId: string) => {
      if (gatewayReferenceId.includes('_ok_')) return 'success';
      if (gatewayReferenceId.includes('_decl_')) return 'failed';
      return 'unknown';
    }),
  };
}

function buildRecovery(
  prisma: PrismaClient,
  gateway: IPaymentGateway,
  scheduler: RecordingPaymentRetryScheduler,
): PaymentRecoveryService {
  const repository = new PaymentProcessingRepository(prisma as unknown as PrismaClient);
  const retryTiming = retryTimingFromEnv(testEnv);
  return new PaymentRecoveryService(repository, gateway, logger, scheduler, retryTiming, {
    enabled: true,
    intervalMs: 999_999_999,
    minIdleAfterLeaseMs: 0,
    batchSize: 20,
  });
}

describe('Payment system comprehensive suite', () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  describe('1. Payment initiation', () => {
    it('creates a Pending payment with normalized fields', async () => {
      const app = createApp({ env: testEnv, logger, prisma });

      const res = await request(app)
        .post('/payments')
        .set('Idempotency-Key', 'suite-01-initiate')
        .send({ amount: 99.5, currency: 'EUR' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        status: 'Pending',
        currency: 'EUR',
        amount: '99.5',
        idempotencyKey: 'suite-01-initiate',
        retryCount: 0,
      });
    });
  });

  describe('2. Idempotency key behavior', () => {
    it('returns the same payment on replay with 200 and identical id', async () => {
      const app = createApp({ env: testEnv, logger, prisma });
      const key = 'suite-02-idempotency';

      const first = await request(app)
        .post('/payments')
        .set('Idempotency-Key', key)
        .send({ amount: 12, currency: 'USD' });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post('/payments')
        .set('Idempotency-Key', key)
        .send({ amount: 12, currency: 'USD' });

      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.amount).toBe(first.body.data.amount);
    });
  });

  describe('3. Payment status tracking', () => {
    it('reflects lifecycle via GET /payments/:id', async () => {
      const gateway = successGateway('gw_suite_status');
      const app = createApp({ env: testEnv, logger, prisma, paymentGateway: gateway });

      const { id } = await postInitiate(app, 'suite-03-status');

      let get = await request(app).get(`/payments/${id}`);
      expect(get.status).toBe(200);
      expect(get.body.data.status).toBe('Pending');

      await request(app).post(`/payments/${id}/process`).send({});

      get = await request(app).get(`/payments/${id}`);
      expect(get.status).toBe(200);
      expect(get.body.data.status).toBe('Success');
      expect(get.body.data.gatewayReferenceId).toBe('gw_suite_status');
    });
  });

  describe('4. Gateway success', () => {
    it('completes processing with success outcome and persisted reference', async () => {
      const gateway = successGateway('gw_suite_04');
      const app = createApp({ env: testEnv, logger, prisma, paymentGateway: gateway });

      const { id } = await postInitiate(app, 'suite-04-success');

      const res = await request(app).post(`/payments/${id}/process`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('success');
      expect(res.body.data.payment.status).toBe('Success');
      expect(gateway.processPayment).toHaveBeenCalledWith({
        id,
        amount: '10',
        currency: 'USD',
      });
    });
  });

  describe('5. Gateway failure', () => {
    it('returns failure outcome, increments retryCount, keeps Pending', async () => {
      const gateway = failingGateway('issuer_declined');
      const app = createApp({ env: testEnv, logger, prisma, paymentGateway: gateway });

      const { id } = await postInitiate(app, 'suite-05-failure');

      const res = await request(app).post(`/payments/${id}/process`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('failure');
      expect(res.body.data.payment.status).toBe('Pending');
      expect(res.body.data.payment.retryCount).toBe(1);
      expect(res.body.data.payment.failureReason).toBe('issuer_declined');
    });
  });

  describe('6. Gateway timeout', () => {
    it('maps GatewayTimeoutError to timeout outcome and gateway_timeout reason', async () => {
      const gateway: IPaymentGateway = {
        processPayment: jest.fn().mockRejectedValue(new GatewayTimeoutError()),
      };
      const app = createApp({ env: testEnv, logger, prisma, paymentGateway: gateway });

      const { id } = await postInitiate(app, 'suite-06-timeout');

      const res = await request(app).post(`/payments/${id}/process`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('timeout');
      expect(res.body.data.payment.failureReason).toBe('gateway_timeout');
      expect(res.body.data.payment.retryCount).toBe(1);
      expect(res.body.data.payment.status).toBe('Pending');
    });
  });

  describe('7. Retry scheduling with exponential backoff delays', () => {
    it('records scheduler delays matching computeRetryDelayMs after each failure', async () => {
      const timing: RetryTimingConfig = {
        baseDelayMs: 100,
        maxDelayMs: 900_000,
        exponentCap: 10,
      };

      const gateway = failingGateway();
      const { app, scheduler } = createAppWithRecordingRetryScheduler(
        testEnv,
        prisma,
        gateway,
        timing,
        logger,
      );

      const { id } = await postInitiate(app, 'suite-07-backoff');

      for (let i = 0; i < 3; i += 1) {
        const res = await request(app).post(`/payments/${id}/process`).send({});
        expect(res.status).toBe(200);
        expect(res.body.data.outcome).toBe('failure');
      }

      expect(scheduler.calls).toHaveLength(3);
      expect(scheduler.calls[0]?.delayMs).toBe(computeRetryDelayMs(1, timing));
      expect(scheduler.calls[1]?.delayMs).toBe(computeRetryDelayMs(2, timing));
      expect(scheduler.calls[2]?.delayMs).toBe(computeRetryDelayMs(3, timing));
    });
  });

  describe('8. Max retry failure', () => {
    it('marks payment Failed when retries exhausted and stops scheduling', async () => {
      const timing = retryTimingFromEnv(testEnv);
      const gateway = failingGateway('final_fail');
      const { app, scheduler } = createAppWithRecordingRetryScheduler(
        testEnv,
        prisma,
        gateway,
        timing,
        logger,
      );

      const { id } = await postInitiate(app, 'suite-08-max');

      await prisma.payment.update({
        where: { id },
        data: { maxRetries: 3 },
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await request(app).post(`/payments/${id}/process`).send({});
        expect(res.status).toBe(200);
        expect(res.body.data.outcome).toBe('failure');
      }

      const row = await prisma.payment.findUnique({ where: { id } });
      expect(row?.status).toBe('Failed');
      expect(row?.retryCount).toBe(3);

      expect(scheduler.calls).toHaveLength(2);
    });
  });

  describe('9. Concurrent duplicate initiation requests', () => {
    it('persists exactly one row for parallel POSTs with the same key', async () => {
      const app = createApp({ env: testEnv, logger, prisma });
      const key = 'suite-09-concurrent-init';
      const payload = { amount: 3, currency: 'USD' };

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app).post('/payments').set('Idempotency-Key', key).send(payload),
        ),
      );

      const ids = new Set(responses.map((r) => r.body?.data?.id));
      expect(ids.size).toBe(1);
      expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(9);

      const count = await prisma.payment.count({ where: { idempotencyKey: key } });
      expect(count).toBe(1);
    });
  });

  describe('10. Concurrent processing of the same payment', () => {
    it('invokes the gateway once and returns one success plus skipped_busy', async () => {
      const gwMock = jest.fn(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        return { outcome: 'success' as const, gatewayReferenceId: 'gw_suite_10_parallel' };
      });

      const gateway: IPaymentGateway = { processPayment: gwMock };
      const app = createApp({ env: testEnv, logger, prisma, paymentGateway: gateway });

      const { id } = await postInitiate(app, 'suite-10-concurrent-process');

      const responses = await Promise.all([
        request(app).post(`/payments/${id}/process`).send({}),
        request(app).post(`/payments/${id}/process`).send({}),
        request(app).post(`/payments/${id}/process`).send({}),
      ]);

      expect(gwMock).toHaveBeenCalledTimes(1);

      const outcomes = responses.map((r) => r.body?.data?.outcome).sort();
      expect(outcomes.filter((o) => o === 'success')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'skipped_busy')).toHaveLength(2);
    });
  });

  describe('11. Duplicate webhook', () => {
    it('accepts a second identical success webhook as already_success', async () => {
      const app = createApp({ env: testEnv, logger, prisma });
      const { id } = await postInitiate(app, 'suite-11-dup-webhook');

      await prisma.payment.update({
        where: { id },
        data: {
          status: 'Processing',
          gatewayReferenceId: 'gw_suite_11_dup',
          lockedUntil: new Date(Date.now() + 120_000),
        },
      });

      await prisma.paymentAttempt.create({
        data: { paymentId: id, attemptNumber: 1, status: 'Processing' },
      });

      const first = await request(app).post('/webhooks/payment').send({
        gatewayReferenceId: 'gw_suite_11_dup',
        status: 'success',
      });
      const second = await request(app).post('/webhooks/payment').send({
        gatewayReferenceId: 'gw_suite_11_dup',
        status: 'success',
      });

      expect(first.body.data.outcome).toBe('applied_success');
      expect(second.body.data.outcome).toBe('already_success');

      const pay = await prisma.payment.findUnique({ where: { id } });
      expect(pay?.status).toBe('Success');
    });
  });

  describe('12. Early webhook', () => {
    it('returns 202 queued then applies after gateway reference is attached', async () => {
      const gateway = successGateway('gw_suite_12_early');
      const app = createApp({ env: testEnv, logger, prisma, paymentGateway: gateway });

      const { id } = await postInitiate(app, 'suite-12-early');

      const early = await request(app).post('/webhooks/payment').send({
        gatewayReferenceId: 'gw_suite_12_early',
        status: 'success',
      });

      expect(early.status).toBe(202);
      expect(early.body.data.outcome).toBe('queued_early_no_payment');

      await prisma.payment.update({
        where: { id },
        data: {
          status: 'Processing',
          lockedUntil: new Date(Date.now() + 120_000),
        },
      });

      await prisma.paymentAttempt.create({
        data: { paymentId: id, attemptNumber: 1, status: 'Processing' },
      });

      const repo = new PaymentProcessingRepository(prisma as unknown as PrismaClient);
      await repo.attachGatewayReferenceForProcessingPayment(id, 'gw_suite_12_early');

      const stored = await prisma.payment.findUnique({ where: { id } });
      expect(stored?.status).toBe('Success');
      expect(stored?.gatewayReferenceId).toBe('gw_suite_12_early');
    });
  });

  describe('13. Conflicting webhook', () => {
    it('ignores failed webhook after terminal Success', async () => {
      const app = createApp({ env: testEnv, logger, prisma });
      const { id } = await postInitiate(app, 'suite-13-conflict');

      await prisma.payment.update({
        where: { id },
        data: { status: 'Success', gatewayReferenceId: 'gw_suite_13_conflict' },
      });

      const res = await request(app).post('/webhooks/payment').send({
        gatewayReferenceId: 'gw_suite_13_conflict',
        status: 'failed',
        reason: 'issuer_declined',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('ignored_failed_vs_success_conflict');

      const pay = await prisma.payment.findUnique({ where: { id } });
      expect(pay?.status).toBe('Success');
    });
  });

  describe('14. Stuck Processing recovery', () => {
    it('moves stale Processing without gateway probe signal back to Pending and schedules retry', async () => {
      const scheduler = new RecordingPaymentRetryScheduler();
      const gateway = recoveryGatewayProbe();
      const recovery = buildRecovery(prisma, gateway, scheduler);

      const created = await prisma.payment.create({
        data: {
          idempotencyKey: 'suite-14a-recovery',
          amount: new Prisma.Decimal(10),
          currency: 'USD',
          status: 'Pending',
        },
      });

      await prisma.payment.update({
        where: { id: created.id },
        data: { status: 'Processing', lockedUntil: EXPIRED_LEASE },
      });

      await prisma.paymentAttempt.create({
        data: { paymentId: created.id, attemptNumber: 1, status: 'Processing' },
      });

      await recovery.runRecoverySweep();

      const updated = await prisma.payment.findUnique({ where: { id: created.id } });
      expect(updated?.status).toBe('Pending');
      expect(updated?.retryCount).toBe(1);
      expect(updated?.failureReason).toBe('recovery_stale_processing');
      expect(scheduler.calls).toHaveLength(1);
      expect(scheduler.calls[0]?.paymentId).toBe(created.id);
    });

    it('reconciles stale Processing to Success when probe finds gateway success', async () => {
      const scheduler = new RecordingPaymentRetryScheduler();
      const gateway = recoveryGatewayProbe();
      const recovery = buildRecovery(prisma, gateway, scheduler);

      const created = await prisma.payment.create({
        data: {
          idempotencyKey: 'suite-14b-recovery-ok',
          amount: new Prisma.Decimal(11),
          currency: 'USD',
          status: 'Pending',
        },
      });

      await prisma.payment.update({
        where: { id: created.id },
        data: {
          status: 'Processing',
          gatewayReferenceId: 'gw_fake_ok_probe_row',
          lockedUntil: EXPIRED_LEASE,
        },
      });

      await prisma.paymentAttempt.create({
        data: { paymentId: created.id, attemptNumber: 1, status: 'Processing' },
      });

      await recovery.runRecoverySweep();

      const updated = await prisma.payment.findUnique({ where: { id: created.id } });
      expect(updated?.status).toBe('Success');
      expect(scheduler.calls).toHaveLength(0);
    });
  });

  describe('15. Invalid input handling', () => {
    it('rejects initiate without Idempotency-Key', async () => {
      const app = createApp({ env: testEnv, logger, prisma });

      const res = await request(app).post('/payments').send({ amount: 1, currency: 'USD' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('rejects non-positive amount', async () => {
      const app = createApp({ env: testEnv, logger, prisma });

      const res = await request(app)
        .post('/payments')
        .set('Idempotency-Key', 'suite-15-bad-amount')
        .send({ amount: 0, currency: 'USD' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects initiate currency longer than 3 characters', async () => {
      const app = createApp({ env: testEnv, logger, prisma });

      const res = await request(app)
        .post('/payments')
        .set('Idempotency-Key', 'suite-15-currency')
        .send({ amount: 1, currency: 'USDX' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects webhook body missing gatewayReferenceId', async () => {
      const app = createApp({ env: testEnv, logger, prisma });

      const res = await request(app).post('/webhooks/payment').send({ status: 'success' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
