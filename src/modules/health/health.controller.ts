import type { Request, Response, NextFunction } from 'express';
import type { HealthService } from './health.service';

export class HealthController {
  constructor(private readonly health: HealthService) {}

  getHealth = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const snapshot = await this.health.getHealth();
      const statusCode = snapshot.database === 'up' ? 200 : 503;
      res.status(statusCode).json(snapshot);
    } catch (error) {
      next(error);
    }
  };
}
