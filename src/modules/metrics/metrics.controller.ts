import type { Request, Response, NextFunction } from 'express';
import type { MetricsService } from './metrics.service';

export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  getMetrics = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await this.metrics.getPaymentMetrics();
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  };
}
