import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../../src/app';
import { createLogger } from '../../src/modules/common/logger';
import { testEnv } from '../helpers/test-env';

describe('HTTP 404 handling', () => {
  it('returns structured JSON for unknown routes', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([1]),
    } as unknown as PrismaClient;

    const app = createApp({ env: testEnv, logger: createLogger(testEnv), prisma });

    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
