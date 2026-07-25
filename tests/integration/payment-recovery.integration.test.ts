import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { createFakeExternalGatewayFromEnv } from '../../src/modules/gateway/fake-external-gateway.service';
import { PaymentProcessingRepository } from '../../src/modules/payments/payment-processing.repository';
import { PaymentRecoveryService } from '../../src/modules/payments/payment-recovery.service';
import { retryTimingFromEnv } from '../../src/modules/payments/payment-retry.policy';
import { createLogger } from '../../src/modules/common/logger';
import { createPaymentTestPrisma } from '../helpers/create-payment-test-prisma';
import { RecordingPaymentRetryScheduler } from '../helpers/recording-payment-retry.scheduler';
import { testEnv } from '../helpers/test-env';

describe('PaymentRecoveryService (stuck Processing)', () => {
  let prisma: PrismaClient;
  const staleLease = (): Date => new Date(Date.now() - 120_000);

  function buildRecovery(
    prismaClient: PrismaClient,
    scheduler: RecordingPaymentRetryScheduler,
  ): PaymentRecoveryService {
    const repository = new PaymentProcessingRepository(prismaClient as unknown as PrismaClient);
    const gateway = createFakeExternalGatewayFromEnv(testEnv);
    const logger = createLogger(testEnv);
    const retryTiming = retryTimingFromEnv(testEnv);

    return new PaymentRecoveryService(repository, gateway, logger, scheduler, retryTiming, {
      enabled: true,
      intervalMs: 999_999_999,
      minIdleAfterLeaseMs: 0,
      batchSize: 20,
    });
  }

  beforeEach(() => {
    prisma = createPaymentTestPrisma();
  });

  it('marks lease-expired Processing payment failed locally and leaves room for retry', async () => {
    const scheduler = new RecordingPaymentRetryScheduler();
    const recovery = buildRecovery(prisma, scheduler);

    const created = await prisma.payment.create({
      data: {
        idempotencyKey: `recovery-stuck-${Date.now()}`,
        amount: new Prisma.Decimal(10),
        currency: 'USD',
        status: 'Pending',
      },
    });

    await prisma.payment.update({
      where: { id: created.id },
      data: {
        status: 'Processing',
        lockedUntil: staleLease(),
      },
    });

    await prisma.paymentAttempt.create({
      data: {
        paymentId: created.id,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    await recovery.runRecoverySweep();

    const updated = await prisma.payment.findUnique({ where: { id: created.id } });
    expect(updated?.status).toBe('Pending');
    expect(updated?.retryCount).toBe(1);
    expect(updated?.failureReason).toBe('recovery_stale_processing');

    expect(scheduler.calls).toHaveLength(1);
    expect(scheduler.calls[0]?.paymentId).toBe(created.id);
  });

  it('reconciles to Success when gateway probe reports success for stale Processing', async () => {
    const scheduler = new RecordingPaymentRetryScheduler();
    const recovery = buildRecovery(prisma, scheduler);

    const created = await prisma.payment.create({
      data: {
        idempotencyKey: `recovery-gw-ok-${Date.now()}`,
        amount: new Prisma.Decimal(10),
        currency: 'USD',
        status: 'Pending',
      },
    });

    await prisma.payment.update({
      where: { id: created.id },
      data: {
        status: 'Processing',
        gatewayReferenceId: 'gw_fake_ok_stale_row',
        lockedUntil: staleLease(),
      },
    });

    await prisma.paymentAttempt.create({
      data: {
        paymentId: created.id,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    await recovery.runRecoverySweep();

    const updated = await prisma.payment.findUnique({ where: { id: created.id } });
    expect(updated?.status).toBe('Success');
    expect(scheduler.calls).toHaveLength(0);
  });

  it('does not schedule retry after recovery when max retries would be exceeded', async () => {
    const scheduler = new RecordingPaymentRetryScheduler();
    const recovery = buildRecovery(prisma, scheduler);

    const created = await prisma.payment.create({
      data: {
        idempotencyKey: `recovery-terminal-${Date.now()}`,
        amount: new Prisma.Decimal(10),
        currency: 'USD',
        status: 'Pending',
      },
    });

    await prisma.payment.update({
      where: { id: created.id },
      data: {
        status: 'Processing',
        retryCount: 4,
        maxRetries: 5,
        lockedUntil: staleLease(),
      },
    });

    await prisma.paymentAttempt.create({
      data: {
        paymentId: created.id,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    await recovery.runRecoverySweep();

    const updated = await prisma.payment.findUnique({ where: { id: created.id } });
    expect(updated?.status).toBe('Failed');
    expect(updated?.retryCount).toBe(5);
    expect(scheduler.calls).toHaveLength(0);
  });

  it('does not touch successful payments (no stuck rows, recovery apply is a no-op)', async () => {
    const scheduler = new RecordingPaymentRetryScheduler();
    const recovery = buildRecovery(prisma, scheduler);

    const created = await prisma.payment.create({
      data: {
        idempotencyKey: `recovery-success-${Date.now()}`,
        amount: new Prisma.Decimal(10),
        currency: 'USD',
        status: 'Pending',
      },
    });

    await prisma.payment.update({
      where: { id: created.id },
      data: {
        status: 'Success',
        gatewayReferenceId: 'gw_ok_stable',
        lockedUntil: staleLease(),
      },
    });

    await recovery.runRecoverySweep();

    const repo = new PaymentProcessingRepository(prisma as unknown as PrismaClient);
    const manual = await repo.applyStaleProcessingRecovery({
      paymentId: created.id,
      minIdleAfterLeaseMs: 0,
      decision: 'local_failure',
      failureReason: 'should_not_apply',
    });

    expect(manual?.outcome).toBe('skipped_already_success');

    const updated = await prisma.payment.findUnique({ where: { id: created.id } });
    expect(updated?.status).toBe('Success');
    expect(scheduler.calls).toHaveLength(0);
  });

  it('is idempotent when recovery runs twice after first sweep cleared Processing', async () => {
    const scheduler = new RecordingPaymentRetryScheduler();
    const recovery = buildRecovery(prisma, scheduler);

    const created = await prisma.payment.create({
      data: {
        idempotencyKey: `recovery-idem-${Date.now()}`,
        amount: new Prisma.Decimal(10),
        currency: 'USD',
        status: 'Pending',
      },
    });

    await prisma.payment.update({
      where: { id: created.id },
      data: {
        status: 'Processing',
        lockedUntil: staleLease(),
      },
    });

    await prisma.paymentAttempt.create({
      data: {
        paymentId: created.id,
        attemptNumber: 1,
        status: 'Processing',
      },
    });

    await recovery.runRecoverySweep();
    await recovery.runRecoverySweep();

    const updated = await prisma.payment.findUnique({ where: { id: created.id } });
    expect(updated?.retryCount).toBe(1);
    expect(scheduler.calls).toHaveLength(1);
  });
});
