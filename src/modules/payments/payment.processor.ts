import type { Payment } from './payment.types';
import { NotImplementedError } from '../common/errors';

export interface PaymentProcessor {
  authorize(payment: Payment): Promise<{ gatewayReferenceId: string }>;
  capture(gatewayReferenceId: string): Promise<void>;
}

/** Placeholder implementation until settlement flows are built. */
export class StubPaymentProcessor implements PaymentProcessor {
  authorize(_payment: Payment): Promise<{ gatewayReferenceId: string }> {
    void _payment;
    return Promise.reject(new NotImplementedError('Payment authorization is not implemented'));
  }

  capture(_gatewayReferenceId: string): Promise<void> {
    void _gatewayReferenceId;
    return Promise.reject(new NotImplementedError('Payment capture is not implemented'));
  }
}
