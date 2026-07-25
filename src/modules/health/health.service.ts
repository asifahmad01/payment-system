import type { PrismaClient } from '@prisma/client';

export type HealthStatus = 'ok' | 'degraded';

export interface HealthSnapshot {
  status: HealthStatus;
  uptimeSeconds: number;
  database: 'up' | 'down';
  timestamp: string;
}

export class HealthService {
  constructor(private readonly prisma: PrismaClient) {}

  async getHealth(): Promise<HealthSnapshot> {
    let database: 'up' | 'down' = 'down';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    const status: HealthStatus = database === 'up' ? 'ok' : 'degraded';

    return {
      status,
      uptimeSeconds: Math.round(process.uptime()),
      database,
      timestamp: new Date().toISOString(),
    };
  }
}
