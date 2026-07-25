import type {
  FakeGatewayPayment,
  FakeGatewayProcessResult,
} from '../gateway/fake-external-gateway.types';

/** Authoritative charge outcome from the PSP for stale / recovery probes. */
export type GatewayChargeStatus = 'pending' | 'success' | 'failed' | 'unknown';

/** Outbound payment orchestration boundary (fake or real PSP implementation). */
export interface IPaymentGateway {
  processPayment(payment: FakeGatewayPayment): Promise<FakeGatewayProcessResult>;
  /** Optional inquiry used by recovery — absent gateways default to unknown via caller. */
  getChargeStatus?(gatewayReferenceId: string): Promise<GatewayChargeStatus>;
}
