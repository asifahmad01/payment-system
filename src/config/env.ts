import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a PostgreSQL connection string',
    }),

  /** Fake external gateway simulation (not wired into processing yet). */
  PAYMENT_GATEWAY_SIM_SUCCESS_PROB: z.coerce.number().min(0).max(1).default(0.85),
  PAYMENT_GATEWAY_SIM_FAILURE_PROB: z.coerce.number().min(0).max(1).default(0.1),
  PAYMENT_GATEWAY_SIM_TIMEOUT_PROB: z.coerce.number().min(0).max(1).default(0.05),
  PAYMENT_GATEWAY_SIM_DELAY_MIN_MS: z.coerce.number().int().min(0).default(500),
  PAYMENT_GATEWAY_SIM_DELAY_MAX_MS: z.coerce.number().int().min(0).default(3000),

  REDIS_URL: z.string().min(1).optional(),
  PAYMENT_RETRY_ENABLED: z.preprocess((val) => {
    if (val === undefined || val === '') return false;
    if (typeof val === 'boolean') return val;
    const s = String(val).toLowerCase().trim();
    return s === 'true' || s === '1' || s === 'yes';
  }, z.boolean()),
  PAYMENT_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(5_000),
  PAYMENT_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(900_000),
  PAYMENT_RETRY_EXPONENT_CAP: z.coerce.number().int().min(0).default(10),

  PAYMENT_RECOVERY_ENABLED: z.preprocess((val) => {
    if (val === undefined || val === '') return false;
    if (typeof val === 'boolean') return val;
    const s = String(val).toLowerCase().trim();
    return s === 'true' || s === '1' || s === 'yes';
  }, z.boolean()),
  /** How often the recovery sweep runs (when enabled). */
  PAYMENT_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  /** Require `lockedUntil` to be at least this many ms in the past before touching the row. */
  PAYMENT_RECOVERY_MIN_IDLE_AFTER_LEASE_MS: z.coerce.number().int().min(0).default(0),
  PAYMENT_RECOVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
}).superRefine((data, ctx) => {
  if (data.PAYMENT_GATEWAY_SIM_DELAY_MAX_MS < data.PAYMENT_GATEWAY_SIM_DELAY_MIN_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PAYMENT_GATEWAY_SIM_DELAY_MAX_MS must be >= PAYMENT_GATEWAY_SIM_DELAY_MIN_MS',
      path: ['PAYMENT_GATEWAY_SIM_DELAY_MAX_MS'],
    });
  }

  const sum =
    data.PAYMENT_GATEWAY_SIM_SUCCESS_PROB +
    data.PAYMENT_GATEWAY_SIM_FAILURE_PROB +
    data.PAYMENT_GATEWAY_SIM_TIMEOUT_PROB;
  if (sum <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Gateway simulation probabilities must sum to a positive value (SUCCESS + FAILURE + TIMEOUT)',
      path: ['PAYMENT_GATEWAY_SIM_SUCCESS_PROB'],
    });
  }

  if (data.PAYMENT_RETRY_ENABLED && !data.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'REDIS_URL is required when PAYMENT_RETRY_ENABLED is true',
      path: ['REDIS_URL'],
    });
  }

  if (data.PAYMENT_RETRY_MAX_DELAY_MS < data.PAYMENT_RETRY_BASE_DELAY_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PAYMENT_RETRY_MAX_DELAY_MS must be >= PAYMENT_RETRY_BASE_DELAY_MS',
      path: ['PAYMENT_RETRY_MAX_DELAY_MS'],
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) {
    return cached;
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment configuration: ${JSON.stringify(message)}`);
  }
  cached = parsed.data;
  return parsed.data;
}

export function resetEnvCache(): void {
  cached = null;
}
