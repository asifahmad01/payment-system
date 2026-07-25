import type { NextFunction, Request, Response } from 'express';
import type { PaymentService } from './payment.service';
import type { PaymentProcessingService } from './payment-processing.service';
import { paymentToDto } from './payment.serialization';
import { NotFoundError } from '../common/errors';

export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly processing: PaymentProcessingService,
  ) {}

  initiate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { payment, created } = await this.payments.initiatePayment(
        req.idempotencyKey!,
        req.body.amount as number,
        req.body.currency as string,
        { requestId: req.requestId },
      );

      const statusCode = created ? 201 : 200;
      res.status(statusCode).json({ data: paymentToDto(payment) });
    } catch (error) {
      next(error);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawId = req.params.id?.trim();
      if (!rawId) {
        next(new NotFoundError('Payment', req.params.id ?? ''));
        return;
      }

      const payment = await this.payments.getPayment(rawId);
      res.status(200).json({ data: paymentToDto(payment) });
    } catch (error) {
      next(error);
    }
  };

  processPayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawId = req.params.id?.trim();
      if (!rawId) {
        next(new NotFoundError('Payment', req.params.id ?? ''));
        return;
      }

      const result = await this.processing.processPaymentById(rawId, {
        requestId: req.requestId,
      });

      res.status(200).json({
        data: {
          payment: paymentToDto(result.payment),
          outcome: result.outcome,
          attemptNumber: result.attemptNumber,
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
