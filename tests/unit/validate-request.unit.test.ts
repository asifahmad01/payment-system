import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { errorMiddleware } from '../../src/middleware/error.middleware';
import { notFoundMiddleware } from '../../src/middleware/not-found.middleware';
import { validateBody } from '../../src/middleware/validate-request';
import { createLogger } from '../../src/modules/common/logger';
import { testEnv } from '../helpers/test-env';

describe('validateBody middleware', () => {
  it('passes parsed payloads forward', async () => {
    const logger = createLogger(testEnv);
    const app = express();
    app.use(express.json());

    app.post(
      '/demo',
      validateBody(
        z.object({
          name: z.string().min(1),
        }),
      ),
      (req, res) => {
        res.status(201).json({ name: req.body.name });
      },
    );

    app.use(notFoundMiddleware);
    app.use(errorMiddleware(logger));

    const response = await request(app).post('/demo').send({ name: 'Ada' });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Ada');
  });

  it('surfaces validation errors via the shared error handler', async () => {
    const logger = createLogger(testEnv);
    const app = express();
    app.use(express.json());

    app.post(
      '/demo',
      validateBody(
        z.object({
          name: z.string().min(1),
        }),
      ),
      (_req, res) => res.status(201).end(),
    );

    app.use(notFoundMiddleware);
    app.use(errorMiddleware(logger));

    const response = await request(app).post('/demo').send({ name: '' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toBeDefined();
  });
});
