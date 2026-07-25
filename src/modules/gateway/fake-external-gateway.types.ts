/** Narrow payment snapshot passed into the simulator (no Prisma coupling). */
export interface FakeGatewayPayment {
  id: string;
  amount: string;
  currency: string;
}

export interface FakeGatewaySuccessResult {
  outcome: 'success';
  gatewayReferenceId: string;
}

export interface FakeGatewayFailureResult {
  outcome: 'failure';
  gatewayReferenceId: string;
  failureReason: string;
}

export type FakeGatewayProcessResult = FakeGatewaySuccessResult | FakeGatewayFailureResult;

/** Injectable RNG / scheduler for deterministic tests. */
export interface FakeExternalGatewayDeps {
  random: () => number;
  sleep: (ms: number) => Promise<void>;
}
