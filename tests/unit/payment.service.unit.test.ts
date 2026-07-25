import { Prisma } from '@prisma/client';
import { PaymentService } from '../../src/modules/payments/payment.service';
import type { PaymentRepository } from '../../src/modules/payments/payment.repository';
import type { PaymentProcessor } from '../../src/modules/payments/payment.processor';
import { NotFoundError } from '../../src/modules/common/errors';
import { createLogger } from '../../src/modules/common/logger';

const silentLogger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

function mockPayment(overrides: Partial<{ id: string; idempotencyKey: string }> = {}) {
  const now = new Date();
  return {
    id: overrides.id ?? 'pay_1',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    amount: new Prisma.Decimal('10.00'),
    currency: 'USD',
    status: 'Pending' as const,
    gatewayReferenceId: null,
    retryCount: 0,
    maxRetries: 5,
    failureReason: null,
    lockedUntil: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('PaymentService.initiatePayment', () => {
  const processor = {} as PaymentProcessor;

  it('returns persisted payment from transactional path when key already exists', async () => {
    const existing = mockPayment();
    const repository: jest.Mocked<Pick<PaymentRepository, 'createPendingOrGetByKey'>> = {
      createPendingOrGetByKey: jest.fn().mockResolvedValue({ payment: existing, created: false }),
    };

    const service = new PaymentService(repository as unknown as PaymentRepository, processor, silentLogger);

    const result = await service.initiatePayment('idem-1', 10, 'USD');

    expect(result.created).toBe(false);
    expect(result.payment).toEqual(existing);
    expect(repository.createPendingOrGetByKey).toHaveBeenCalledWith({
      idempotencyKey: 'idem-1',
      amount: 10,
      currency: 'USD',
    });
  });

  it('returns created=true when repository inserts Pending inside the transaction', async () => {
    const created = mockPayment({ id: 'pay_new' });
    const repository: jest.Mocked<Pick<PaymentRepository, 'createPendingOrGetByKey'>> = {
      createPendingOrGetByKey: jest.fn().mockResolvedValue({ payment: created, created: true }),
    };

    const service = new PaymentService(repository as unknown as PaymentRepository, processor, silentLogger);

    const result = await service.initiatePayment('idem-new', 10, 'USD');

    expect(result.created).toBe(true);
    expect(result.payment.id).toBe('pay_new');
  });

  it('resolves to stored payment when Serializable txn loses race and unique constraint fires', async () => {
    const duplicateError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['idempotencyKey'] },
    });

    const persisted = mockPayment({ id: 'pay_winner', idempotencyKey: 'idem-race' });

    const repository: jest.Mocked<
      Pick<PaymentRepository, 'createPendingOrGetByKey' | 'findByIdempotencyKey'>
    > = {
      createPendingOrGetByKey: jest.fn().mockRejectedValue(duplicateError),
      findByIdempotencyKey: jest.fn().mockResolvedValue(persisted),
    };

    const service = new PaymentService(repository as unknown as PaymentRepository, processor, silentLogger);

    const result = await service.initiatePayment('idem-race', 25.5, 'EUR');

    expect(result.created).toBe(false);
    expect(result.payment.id).toBe('pay_winner');
    expect(repository.findByIdempotencyKey).toHaveBeenCalledWith('idem-race');
  });

  it('rethrows unexpected persistence errors', async () => {
    const boom = new Error('database unavailable');
    const repository: jest.Mocked<Pick<PaymentRepository, 'createPendingOrGetByKey'>> = {
      createPendingOrGetByKey: jest.fn().mockRejectedValue(boom),
    };

    const service = new PaymentService(repository as unknown as PaymentRepository, processor, silentLogger);

    await expect(service.initiatePayment('idem-x', 1, 'USD')).rejects.toThrow('database unavailable');
  });
});

describe('PaymentService.getPayment', () => {
  const processor = {} as PaymentProcessor;

  it('returns the payment when the repository finds a row', async () => {
    const row = mockPayment({ id: 'pay_lookup', idempotencyKey: 'ik' });
    const repository: jest.Mocked<Pick<PaymentRepository, 'findById'>> = {
      findById: jest.fn().mockResolvedValue(row),
    };

    const service = new PaymentService(repository as unknown as PaymentRepository, processor, silentLogger);

    await expect(service.getPayment('pay_lookup')).resolves.toEqual(row);
    expect(repository.findById).toHaveBeenCalledWith('pay_lookup');
  });

  it('throws NotFoundError when the repository returns null', async () => {
    const repository: jest.Mocked<Pick<PaymentRepository, 'findById'>> = {
      findById: jest.fn().mockResolvedValue(null),
    };

    const service = new PaymentService(repository as unknown as PaymentRepository, processor, silentLogger);

    await expect(service.getPayment('missing')).rejects.toThrow(NotFoundError);
    expect(repository.findById).toHaveBeenCalledWith('missing');
  });
});
