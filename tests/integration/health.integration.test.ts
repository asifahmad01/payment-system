import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { createLogger } from '../../src/modules/common/logger';
import { testEnv } from '../helpers/test-env';

describe('HTTP /health', () => {
  it('returns 200 when the database responds', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([1]),
    } as unknown as PrismaClient;

    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.database).toBe('up');
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(typeof response.body.timestamp).toBe('string');
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('returns 503 when the database check fails', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as PrismaClient;

    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.database).toBe('down');
  });
});
