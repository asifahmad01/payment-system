import type { AppLogger } from './logger';

/** Carry correlation through controllers → services (workers omit requestId). */
export interface PaymentLogContext {
  requestId?: string;
}

export type StructuredLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const SENSITIVE_METADATA_KEYS = new Set([
  'amount',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'pan',
  'password',
  'authorization',
  'token',
]);

/** Strip fields that must not appear in logs (callers should prefer IDs and enums). */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_METADATA_KEYS.has(key.toLowerCase())) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Consistent domain shape on top of Pino defaults (`time`, `level`, `pid`, …):
 * `event`, optional `requestId`, `paymentId`, `metadata`, and `err` (+ `failureReason`).
 */
export function logStructured(
  logger: AppLogger,
  level: StructuredLogLevel,
  payload: {
    event: string;
    requestId?: string;
    paymentId?: string;
    metadata?: Record<string, unknown>;
    err?: Error;
  },
): void {
  const line: Record<string, unknown> = { event: payload.event };
  if (payload.requestId !== undefined) {
    line.requestId = payload.requestId;
  }
  if (payload.paymentId !== undefined) {
    line.paymentId = payload.paymentId;
  }
  if (payload.metadata !== undefined && Object.keys(payload.metadata).length > 0) {
    line.metadata = sanitizeMetadata(payload.metadata);
  }
  if (payload.err !== undefined) {
    line.err = payload.err;
    line.failureReason = payload.err.message;
  }

  logger[level](line);
}
