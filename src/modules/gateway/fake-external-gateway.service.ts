import type { Env } from '../../config/env';
import { GatewayTimeoutError } from '../common/errors';
import type { GatewayChargeStatus } from '../payments/payment-gateway.port';
import type {
  FakeExternalGatewayDeps,
  FakeGatewayPayment,
  FakeGatewayProcessResult,
} from './fake-external-gateway.types';

export interface FakeExternalGatewaySimulationOptions {
  successProbability: number;
  failureProbability: number;
  timeoutProbability: number;
  delayMinMs: number;
  delayMaxMs: number;
  deps?: Partial<FakeExternalGatewayDeps>;
}

function defaultDeps(): FakeExternalGatewayDeps {
  return {
    random: () => Math.random(),
    sleep: (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

function normalizeProbabilities(success: number, failure: number, timeout: number): {
  success: number;
  failure: number;
  timeout: number;
} {
  const sum = success + failure + timeout;
  if (sum <= 0) {
    throw new Error('Gateway simulation probabilities must sum to a positive number');
  }
  return {
    success: success / sum,
    failure: failure / sum,
    timeout: timeout / sum,
  };
}

function pickDelayMs(min: number, max: number, random: () => number): number {
  if (max < min) {
    throw new Error('delayMaxMs must be >= delayMinMs');
  }
  const span = max - min;
  return min + Math.floor(random() * (span + 1));
}

/**
 * Standalone simulator for an external PSP-style gateway.
 * Not connected to application payment flows yet — inject explicit {@link FakeExternalGatewaySimulationOptions}
 * or build from env via {@link createFakeExternalGatewayFromEnv}.
 */
export class FakeExternalGatewayService {
  private readonly successCutoff: number;
  private readonly failureCutoff: number;
  private readonly delayMinMs: number;
  private readonly delayMaxMs: number;
  private readonly deps: FakeExternalGatewayDeps;

  constructor(options: FakeExternalGatewaySimulationOptions) {
    const normalized = normalizeProbabilities(
      options.successProbability,
      options.failureProbability,
      options.timeoutProbability,
    );
    this.successCutoff = normalized.success;
    this.failureCutoff = normalized.success + normalized.failure;
    this.delayMinMs = options.delayMinMs;
    this.delayMaxMs = options.delayMaxMs;
    this.deps = { ...defaultDeps(), ...options.deps };
  }

  async processPayment(payment: FakeGatewayPayment): Promise<FakeGatewayProcessResult> {
    const delayMs = pickDelayMs(this.delayMinMs, this.delayMaxMs, this.deps.random);
    await this.deps.sleep(delayMs);

    const roll = this.deps.random();

    if (roll < this.successCutoff) {
      return {
        outcome: 'success',
        gatewayReferenceId: this.makeGatewayReferenceId(payment.id, 'ok'),
      };
    }

    if (roll < this.failureCutoff) {
      return {
        outcome: 'failure',
        gatewayReferenceId: this.makeGatewayReferenceId(payment.id, 'decl'),
        failureReason: 'simulated_gateway_decline',
      };
    }

    throw new GatewayTimeoutError();
  }

  /**
   * Deterministic probe for recovery/tests: refs produced by {@link makeGatewayReferenceId}
   * embed `_ok_` / `_decl_` so stale rows can be reconciled without external HTTP.
   */
  async getChargeStatus(gatewayReferenceId: string): Promise<GatewayChargeStatus> {
    if (gatewayReferenceId.includes('_ok_')) {
      return 'success';
    }
    if (gatewayReferenceId.includes('_decl_')) {
      return 'failed';
    }
    return 'unknown';
  }

  private makeGatewayReferenceId(paymentId: string, suffix: string): string {
    const nonce = Math.floor(this.deps.random() * Number.MAX_SAFE_INTEGER).toString(36);
    return `gw_fake_${suffix}_${paymentId}_${nonce}`;
  }
}

export function createFakeExternalGatewayFromEnv(env: Env): FakeExternalGatewayService {
  return new FakeExternalGatewayService({
    successProbability: env.PAYMENT_GATEWAY_SIM_SUCCESS_PROB,
    failureProbability: env.PAYMENT_GATEWAY_SIM_FAILURE_PROB,
    timeoutProbability: env.PAYMENT_GATEWAY_SIM_TIMEOUT_PROB,
    delayMinMs: env.PAYMENT_GATEWAY_SIM_DELAY_MIN_MS,
    delayMaxMs: env.PAYMENT_GATEWAY_SIM_DELAY_MAX_MS,
  });
}
