import type { PrismaClient } from '@prisma/client';

export interface PaymentMetricsSnapshot {
  totalPayments: number;
  byStatus: Record<string, number>;
  retrySummary: {
    sumRetryCount: number;
    avgRetryCount: number;
    maxRetryCount: number;
    pendingPaymentsWithRetries: number;
  };
}

export class MetricsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getPaymentMetrics(): Promise<PaymentMetricsSnapshot> {
    const [totalPayments, statusGroups, agg, pendingPaymentsWithRetries] = await Promise.all([
      this.prisma.payment.count(),
      this.prisma.payment.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      this.prisma.payment.aggregate({
        _sum: { retryCount: true },
        _avg: { retryCount: true },
        _max: { retryCount: true },
      }),
      this.prisma.payment.count({
        where: {
          status: 'Pending',
          retryCount: { gt: 0 },
        },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of statusGroups) {
      byStatus[row.status] = row._count.id;
    }

    return {
      totalPayments,
      byStatus,
      retrySummary: {
        sumRetryCount: agg._sum.retryCount ?? 0,
        avgRetryCount: agg._avg.retryCount ?? 0,
        maxRetryCount: agg._max.retryCount ?? 0,
        pendingPaymentsWithRetries,
      },
    };
  }
}
