import { NotFoundError, NotImplementedError } from '../common/errors';
import type { AppLogger } from '../common/logger';
import { logStructured, type PaymentLogContext } from '../common/structured-log';
import { isUniqueConstraintViolation } from '../../infrastructure/prisma-errors';
import type { PaymentProcessor } from './payment.processor';
import type { PaymentRepository } from './payment.repository';
import type { CreatePaymentInput, Payment } from './payment.types';

export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly _processor: PaymentProcessor,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Idempotent initiation: returns an existing row when the key matches,
   * otherwise inserts Pending. Concurrent inserts rely on DB uniqueness + P2002 reconciliation.
   */
  async initiatePayment(
    idempotencyKey: string,
    amount: number,
    currency: string,
    ctx?: PaymentLogContext,
  ): Promise<{ payment: Payment; created: boolean }> {
    try {
      const result = await this.repository.createPendingOrGetByKey({
        idempotencyKey,
        amount,
        currency,
      });

      logStructured(this.logger, 'info', {
        event: 'payment.lifecycle.initiated',
        requestId: ctx?.requestId,
        paymentId: result.payment.id,
        metadata: { created: result.created, currency: result.payment.currency },
      });

      return result;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        const replay = await this.repository.findByIdempotencyKey(idempotencyKey);
        if (replay) {
          logStructured(this.logger, 'info', {
            event: 'payment.lifecycle.initiate_replayed_after_conflict',
            requestId: ctx?.requestId,
            paymentId: replay.id,
            metadata: { currency: replay.currency },
          });
          return { payment: replay, created: false };
        }
      }

      logStructured(this.logger, 'error', {
        event: 'payment.lifecycle.initiate_failed',
        requestId: ctx?.requestId,
        err: error instanceof Error ? error : new Error(String(error)),
        metadata: {},
      });

      throw error;
    }
  }

  createPayment(_input: CreatePaymentInput): Promise<Payment> {
    void this._processor;
    void _input;
    return Promise.reject(new NotImplementedError('Legacy createPayment is not implemented'));
  }

  /** Load a payment by primary key; `404` when absent (via {@link NotFoundError}). */
  async getPayment(id: string): Promise<Payment> {
    void this._processor;
    const payment = await this.repository.findById(id);
    if (!payment) {
      throw new NotFoundError('Payment', id);
    }
    return payment;
  }
}
