import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { NotImplementedError } from '../common/errors';
import type { Payment } from './payment.types';

export interface CreatePendingPaymentParams {
  idempotencyKey: string;
  amount: number;
  currency: string;
}

export interface PaymentRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null>;
  createPending(params: CreatePendingPaymentParams): Promise<Payment>;
  /** Serializable transaction: find by key or insert Pending — avoids duplicate rows under concurrent POSTs. */
  createPendingOrGetByKey(
    params: CreatePendingPaymentParams,
  ): Promise<{ payment: Payment; created: boolean }>;
  findById(id: string): Promise<Payment | null>;
  updateStatus(id: string, status: Payment['status']): Promise<Payment>;
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { idempotencyKey } });
  }

  createPending(params: CreatePendingPaymentParams): Promise<Payment> {
    const currency = params.currency.trim();
    return this.prisma.payment.create({
      data: {
        idempotencyKey: params.idempotencyKey,
        amount: new Prisma.Decimal(params.amount),
        currency,
        status: 'Pending',
      },
    });
  }

  async createPendingOrGetByKey(
    params: CreatePendingPaymentParams,
  ): Promise<{ payment: Payment; created: boolean }> {
    const currency = params.currency.trim();
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.payment.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
        });
        if (existing) {
          return { payment: existing, created: false };
        }

        const payment = await tx.payment.create({
          data: {
            idempotencyKey: params.idempotencyKey,
            amount: new Prisma.Decimal(params.amount),
            currency,
            status: 'Pending',
          },
        });
        return { payment, created: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  findById(id: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  updateStatus(_id: string, _status: Payment['status']): Promise<Payment> {
    void _id;
    void _status;
    return Promise.reject(new NotImplementedError('Payment status updates are not implemented'));
  }
}

/** Placeholder for tests that do not hit PostgreSQL. */
export class StubPaymentRepository implements PaymentRepository {
  findByIdempotencyKey(_idempotencyKey: string): Promise<Payment | null> {
    void _idempotencyKey;
    return Promise.reject(new NotImplementedError('Payment persistence is not implemented'));
  }

  createPending(_params: CreatePendingPaymentParams): Promise<Payment> {
    void _params;
    return Promise.reject(new NotImplementedError('Payment persistence is not implemented'));
  }

  createPendingOrGetByKey(_params: CreatePendingPaymentParams): Promise<{
    payment: Payment;
    created: boolean;
  }> {
    void _params;
    return Promise.reject(new NotImplementedError('Payment persistence is not implemented'));
  }

  findById(_id: string): Promise<Payment | null> {
    void _id;
    return Promise.reject(new NotImplementedError('Payment lookup is not implemented'));
  }

  updateStatus(_id: string, _status: Payment['status']): Promise<Payment> {
    void _id;
    void _status;
    return Promise.reject(new NotImplementedError('Payment status updates are not implemented'));
  }
}
