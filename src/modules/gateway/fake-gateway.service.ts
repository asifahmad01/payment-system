import type { PaymentProcessor } from '../payments/payment.processor';
import type { Payment } from '../payments/payment.types';
import { NotImplementedError } from '../common/errors';

/** Simulator stub — gateway interactions will be implemented alongside processor flows. */
export class FakeGatewayService implements PaymentProcessor {
  authorize(_payment: Payment): Promise<{ gatewayReferenceId: string }> {
    void _payment;
    return Promise.reject(new NotImplementedError('Fake gateway authorization is not implemented'));
  }

  capture(_gatewayReferenceId: string): Promise<void> {
    void _gatewayReferenceId;
    return Promise.reject(new NotImplementedError('Fake gateway capture is not implemented'));
  }
}
