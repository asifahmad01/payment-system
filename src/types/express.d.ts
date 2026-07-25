import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlates access logs with domain events (from correlation middleware). */
    requestId?: string;
    /** Normalized Idempotency-Key header for initiate-payment routes. */
    idempotencyKey?: string;
  }
}

export {};
