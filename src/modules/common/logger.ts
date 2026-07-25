import pino from 'pino';
import type { Env } from '../../config/env';

export type AppLogger = pino.Logger;

export function createLogger(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): AppLogger {
  const isDev = env.NODE_ENV === 'development';

  return pino({
    level: env.LOG_LEVEL,
    mixin() {
      return { timestamp: new Date().toISOString() };
    },
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
    base: {
      service: 'payment-api',
      env: env.NODE_ENV,
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      remove: true,
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}
