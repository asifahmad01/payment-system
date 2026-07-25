import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_HEADER = 'x-request-id';
const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Propagate or mint a correlation ID for the request (also exposed as `requestId`
 * for structured domain logs). Echoes `X-Request-Id` on the response.
 */
export function requestCorrelationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming =
    (typeof req.headers[REQUEST_ID_HEADER] === 'string' && req.headers[REQUEST_ID_HEADER]) ||
    (typeof req.headers[CORRELATION_ID_HEADER] === 'string' && req.headers[CORRELATION_ID_HEADER]) ||
    '';

  const trimmed = incoming.trim();
  const requestId = trimmed.length > 0 ? trimmed : randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
}
