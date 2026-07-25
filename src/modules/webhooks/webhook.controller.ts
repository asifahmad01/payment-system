import type { NextFunction, Request, Response } from 'express';
import { paymentToDto } from '../payments/payment.serialization';
import type { PaymentProcessingService } from '../payments/payment-processing.service';

export class WebhookController {
  constructor(private readonly processing: PaymentProcessingService) {}

  handlePaymentWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await this.processing.handlePaymentWebhook(req.body, {
        requestId: req.requestId,
      });

      res.status(result.httpStatus).json({
        data: {
          outcome: result.outcome,
          webhookEventId: result.webhookEventId,
          ...(result.payment ? { payment: paymentToDto(result.payment) } : {}),
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
