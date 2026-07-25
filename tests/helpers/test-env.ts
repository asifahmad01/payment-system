import type { Env } from '../../src/config/env';

/** Satisfies `Env` for tests without repeating gateway simulation defaults. */
export const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 3000,
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://payment:payment@localhost:5432/payment_test?schema=public',
  PAYMENT_GATEWAY_SIM_SUCCESS_PROB: 0.85,
  PAYMENT_GATEWAY_SIM_FAILURE_PROB: 0.1,
  PAYMENT_GATEWAY_SIM_TIMEOUT_PROB: 0.05,
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
};
