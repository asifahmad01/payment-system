import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../modules/common/errors';

export function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers['idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? raw[0]?.trim() : '';

  if (!key) {
    next(new AppError('Idempotency-Key header is required', 'MISSING_IDEMPOTENCY_KEY', 400));
    return;
  }

  req.idempotencyKey = key;
  next();
}
