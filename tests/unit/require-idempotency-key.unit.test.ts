import express from 'express';
import request from 'supertest';
import { requireIdempotencyKey } from '../../src/middleware/require-idempotency-key';
import { errorMiddleware } from '../../src/middleware/error.middleware';
import { createLogger } from '../../src/modules/common/logger';
import { testEnv } from '../helpers/test-env';

describe('requireIdempotencyKey middleware', () => {
  it('rejects when header missing', async () => {
    const logger = createLogger(testEnv);
    const app = express();
    app.use(express.json());
    app.post('/x', requireIdempotencyKey, (_req, res) => res.status(204).end());
    app.use(errorMiddleware(logger));

    const res = await request(app).post('/x').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('populates req.idempotencyKey when header present', async () => {
    const app = express();
    app.use(express.json());
    app.post('/x', requireIdempotencyKey, (req, res) => {
      res.status(200).json({ key: req.idempotencyKey });
    });

    const res = await request(app).post('/x').set('Idempotency-Key', '  abc  ').send({});

    expect(res.status).toBe(200);
    expect(res.body.key).toBe('abc');
  });
});
