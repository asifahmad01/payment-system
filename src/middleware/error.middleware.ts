import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../modules/common/errors';
import type { AppLogger } from '../modules/common/logger';
import { logStructured } from '../modules/common/structured-log';

export function errorMiddleware(logger: AppLogger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const reqLogger = req.log ?? logger;

    if (err instanceof AppError) {
      logStructured(reqLogger, err.statusCode >= 500 ? 'error' : 'warn', {
        event: 'http.request.app_error',
        requestId: req.requestId,
        err,
        metadata: {
          code: err.code,
          statusCode: err.statusCode,
          ...(err.details !== undefined ? { hasDetails: true } : {}),
        },
      });

      const payload: Record<string, unknown> = {
        code: err.code,
        message: err.message,
      };
      if (err.details !== undefined) {
        payload.details = err.details;
      }
      res.status(err.statusCode).json({ error: payload });
      return;
    }

    logStructured(reqLogger, 'error', {
      event: 'http.request.unhandled_error',
      requestId: req.requestId,
      err: err instanceof Error ? err : new Error(String(err)),
      metadata: {},
    });

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  };
}
