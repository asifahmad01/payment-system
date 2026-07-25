import {
  FakeExternalGatewayService,
  createFakeExternalGatewayFromEnv,
} from '../../src/modules/gateway/fake-external-gateway.service';
import { GatewayTimeoutError } from '../../src/modules/common/errors';
import type { FakeExternalGatewayDeps } from '../../src/modules/gateway/fake-external-gateway.types';

function createService(
  probs: { success: number; failure: number; timeout: number },
  delayRange: { min: number; max: number },
  deps: Partial<FakeExternalGatewayDeps>,
): FakeExternalGatewayService {
  return new FakeExternalGatewayService({
    successProbability: probs.success,
    failureProbability: probs.failure,
    timeoutProbability: probs.timeout,
    delayMinMs: delayRange.min,
    delayMaxMs: delayRange.max,
    deps,
  });
}

describe('FakeExternalGatewayService', () => {
  const payment = { id: 'pay_1', amount: '10.00', currency: 'USD' };

  it('returns success with gatewayReferenceId after simulated delay', async () => {
    let calls = 0;
    const random = () => {
      calls += 1;
      if (calls === 1) return 0;
      return 0;
    };

    const sleep = jest.fn(async () => undefined);

    const gateway = createService({ success: 1, failure: 0, timeout: 0 }, { min: 500, max: 500 }, {
      random,
      sleep,
    });

    const result = await gateway.processPayment(payment);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(result).toEqual({
      outcome: 'success',
      gatewayReferenceId: expect.stringMatching(/^gw_fake_ok_pay_1_/),
    });
  });

  it('getChargeStatus inspects synthetic reference ids for recovery probes', async () => {
    const gateway = createService({ success: 1, failure: 0, timeout: 0 }, { min: 0, max: 0 }, {
      random: () => 0,
      sleep: jest.fn(),
    });

    await expect(gateway.getChargeStatus('gw_fake_ok_pay_1_x')).resolves.toBe('success');
    await expect(gateway.getChargeStatus('gw_fake_decl_pay_1_x')).resolves.toBe('failed');
    await expect(gateway.getChargeStatus('gw_unknown')).resolves.toBe('unknown');
  });

  it('returns failure with gatewayReferenceId when outcome is failure', async () => {
    let calls = 0;
    const random = () => {
      calls += 1;
      if (calls === 1) return 0;
      return 0.99;
    };

    const sleep = jest.fn(async () => undefined);

    const gateway = createService({ success: 0, failure: 1, timeout: 0 }, { min: 0, max: 0 }, {
      random,
      sleep,
    });

    const result = await gateway.processPayment(payment);

    expect(result.outcome).toBe('failure');
    expect(result.gatewayReferenceId).toMatch(/^gw_fake_decl_pay_1_/);
    if (result.outcome === 'failure') {
      expect(result.failureReason).toBe('simulated_gateway_decline');
    }
  });

  it('throws GatewayTimeoutError after delay when outcome is timeout', async () => {
    let calls = 0;
    const random = () => {
      calls += 1;
      if (calls === 1) return 0;
      return 0.99;
    };

    const sleep = jest.fn(async () => undefined);

    const gateway = createService({ success: 0, failure: 0, timeout: 1 }, { min: 100, max: 100 }, {
      random,
      sleep,
    });

    await expect(gateway.processPayment(payment)).rejects.toThrow(GatewayTimeoutError);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('uses random delay within [min, max] inclusive before resolving outcome', async () => {
    const capturedDelays: number[] = [];
    let rolls = 0;

    const random = () => {
      rolls += 1;
      if (rolls === 1) return 0.5;
      return 0;
    };

    const sleep = jest.fn(async (ms: number) => {
      capturedDelays.push(ms);
    });

    const gateway = createService({ success: 1, failure: 0, timeout: 0 }, { min: 500, max: 700 }, {
      random,
      sleep,
    });

    await gateway.processPayment(payment);

    expect(capturedDelays).toHaveLength(1);
    expect(capturedDelays[0]).toBeGreaterThanOrEqual(500);
    expect(capturedDelays[0]).toBeLessThanOrEqual(700);

    const expectedMid = 500 + Math.floor(0.5 * (700 - 500 + 1));
    expect(capturedDelays[0]).toBe(expectedMid);
  });

  it('normalizes probability weights so partial configs still partition outcomes', async () => {
    let rolls = 0;
    const random = () => {
      rolls += 1;
      if (rolls === 1) return 0;
      return 0.5;
    };

    const sleep = jest.fn(async () => undefined);

    const gateway = createService({ success: 1, failure: 1, timeout: 1 }, { min: 0, max: 0 }, {
      random,
      sleep,
    });

    const result = await gateway.processPayment(payment);

    expect(result.outcome).toBe('failure');
  });

  it('throws when probability weights sum to zero', () => {
    expect(
      () =>
        new FakeExternalGatewayService({
          successProbability: 0,
          failureProbability: 0,
          timeoutProbability: 0,
          delayMinMs: 0,
          delayMaxMs: 0,
        }),
    ).toThrow(/positive number/);
  });

  it('createFakeExternalGatewayFromEnv wires Env probabilities and delay bounds', () => {
    const gateway = createFakeExternalGatewayFromEnv({
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://localhost:5432/x',
      PAYMENT_GATEWAY_SIM_SUCCESS_PROB: 0.7,
      PAYMENT_GATEWAY_SIM_FAILURE_PROB: 0.2,
      PAYMENT_GATEWAY_SIM_TIMEOUT_PROB: 0.1,
      PAYMENT_GATEWAY_SIM_DELAY_MIN_MS: 500,
      PAYMENT_GATEWAY_SIM_DELAY_MAX_MS: 3000,
      PAYMENT_RETRY_ENABLED: false,
      PAYMENT_RETRY_BASE_DELAY_MS: 5_000,
      PAYMENT_RETRY_MAX_DELAY_MS: 900_000,
      PAYMENT_RETRY_EXPONENT_CAP: 10,
      PAYMENT_RECOVERY_ENABLED: false,
      PAYMENT_RECOVERY_INTERVAL_MS: 60_000,
      PAYMENT_RECOVERY_MIN_IDLE_AFTER_LEASE_MS: 0,
      PAYMENT_RECOVERY_BATCH_SIZE: 50,
    });

    expect(gateway).toBeInstanceOf(FakeExternalGatewayService);
  });
});
