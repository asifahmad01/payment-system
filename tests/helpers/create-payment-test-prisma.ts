import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

type PaymentRow = {
  id: string;
  idempotencyKey: string;
  amount: Prisma.Decimal;
  currency: string;
  status: 'Pending' | 'Processing' | 'Success' | 'Failed';
  gatewayReferenceId: string | null;
  retryCount: number;
  maxRetries: number;
  failureReason: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type AttemptRow = {
  id: string;
  paymentId: string;
  attemptNumber: number;
  status: 'Pending' | 'Processing' | 'Success' | 'Failed';
  gatewayResponse: unknown | null;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
};

type WebhookEventRow = {
  id: string;
  gatewayReferenceId: string;
  eventType: string;
  payload: unknown;
  processed: boolean;
  createdAt: Date;
};

let webhookEventSeq = 0;

function nextWebhookEventId(): string {
  webhookEventSeq += 1;
  return `wh_evt_${webhookEventSeq}`;
}

let idSeq = 0;

function nextPaymentId(): string {
  idSeq += 1;
  return `pay_test_${idSeq}`;
}

let attemptSeq = 0;

function nextAttemptId(): string {
  attemptSeq += 1;
  return `att_test_${attemptSeq}`;
}

function duplicateKeyError(field: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on (${field})`, {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName: 'Payment', target: [field] },
  });
}

function duplicateAttemptError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on attemptNumber', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName: 'PaymentAttempt', target: ['paymentId', 'attemptNumber'] },
  });
}

function matchesPaymentWhere(
  row: PaymentRow,
  where: {
    id?: string;
    status?: PaymentRow['status'] | { in: PaymentRow['status'][] };
    gatewayReferenceId?: string | null;
  },
): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;

  if (where.gatewayReferenceId !== undefined) {
    const g = where.gatewayReferenceId;
    if (g === null) {
      if (row.gatewayReferenceId !== null) return false;
    } else if (row.gatewayReferenceId !== g) {
      return false;
    }
  }

  if (typeof where.status === 'string') {
    if (row.status !== where.status) return false;
  } else if (typeof where.status === 'object' && where.status?.in) {
    if (!where.status.in.includes(row.status)) return false;
  }

  return true;
}

function buildPaymentOps(
  byKey: Map<string, PaymentRow>,
  byId: Map<string, PaymentRow>,
): {
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findMany: jest.Mock;
  deleteMany: jest.Mock;
  count: jest.Mock;
  groupBy: jest.Mock;
  aggregate: jest.Mock;
} {
  return {
    findUnique: jest.fn(
      async ({
        where,
      }: {
        where: { id?: string; idempotencyKey?: string; gatewayReferenceId?: string };
      }) => {
        if (where.id !== undefined) {
          const row = byId.get(where.id);
          return row ? { ...row } : null;
        }
        if (where.idempotencyKey !== undefined) {
          const row = byKey.get(where.idempotencyKey);
          return row ? { ...row } : null;
        }
        if (where.gatewayReferenceId !== undefined) {
          for (const row of byId.values()) {
            if (row.gatewayReferenceId === where.gatewayReferenceId) {
              return { ...row };
            }
          }
          return null;
        }
        return null;
      },
    ),

    create: jest.fn(
      async ({
        data,
      }: {
        data: {
          idempotencyKey: string;
          amount: Prisma.Decimal;
          currency: string;
          status: PaymentRow['status'];
        };
      }) => {
        await Promise.resolve();
        if (byKey.has(data.idempotencyKey)) {
          throw duplicateKeyError('idempotencyKey');
        }

        const now = new Date();
        const row: PaymentRow = {
          id: nextPaymentId(),
          idempotencyKey: data.idempotencyKey,
          amount: data.amount,
          currency: data.currency,
          status: data.status,
          gatewayReferenceId: null,
          retryCount: 0,
          maxRetries: 5,
          failureReason: null,
          lockedUntil: null,
          createdAt: now,
          updatedAt: now,
        };

        byKey.set(data.idempotencyKey, row);
        byId.set(row.id, row);
        return { ...row };
      },
    ),

    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<PaymentRow> & { gatewayReferenceId?: string | null };
      }) => {
        const row = byId.get(where.id);
        if (!row) {
          throw new Error(`Payment ${where.id} not found`);
        }
        const next: PaymentRow = {
          ...row,
          ...mergePaymentPatch(row, data),
          updatedAt: new Date(),
        };
        byId.set(where.id, next);
        byKey.set(next.idempotencyKey, next);
        return { ...next };
      },
    ),

    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: {
          id?: string;
          status?: PaymentRow['status'] | { in: PaymentRow['status'][] };
          gatewayReferenceId?: string | null;
        };
        data: Partial<PaymentRow>;
      }) => {
        await Promise.resolve();
        let count = 0;
        const candidates =
          where.id !== undefined
            ? ([byId.get(where.id)].filter(Boolean) as PaymentRow[])
            : [...byId.values()];

        for (const row of candidates) {
          if (!matchesPaymentWhere(row, where)) continue;
          const next: PaymentRow = {
            ...row,
            ...mergePaymentPatch(row, data),
            updatedAt: new Date(),
          };
          byId.set(next.id, next);
          byKey.set(next.idempotencyKey, next);
          count += 1;
        }
        return { count };
      },
    ),

    findMany: jest.fn(
      async ({
        where,
        select,
        take,
        orderBy,
      }: {
        where?: {
          status?: PaymentRow['status'];
          lockedUntil?: { not?: null; lte?: Date };
        };
        select?: { id?: boolean };
        take?: number;
        orderBy?: { lockedUntil?: 'asc' | 'desc' };
      }) => {
        await Promise.resolve();
        let rows = [...byId.values()];
        if (where?.status !== undefined) {
          rows = rows.filter((r) => r.status === where.status);
        }
        if (where?.lockedUntil !== undefined) {
          const lu = where.lockedUntil;
          if ('not' in lu && lu.not === null) {
            rows = rows.filter((r) => r.lockedUntil !== null);
          }
          if (lu.lte !== undefined) {
            rows = rows.filter(
              (r) => r.lockedUntil !== null && r.lockedUntil.getTime() <= lu.lte!.getTime(),
            );
          }
        }
        if (orderBy?.lockedUntil === 'asc') {
          rows.sort((a, b) => {
            const ta = a.lockedUntil?.getTime() ?? 0;
            const tb = b.lockedUntil?.getTime() ?? 0;
            return ta - tb;
          });
        }
        if (take !== undefined) {
          rows = rows.slice(0, take);
        }
        if (select?.id) {
          return rows.map((r) => ({ id: r.id }));
        }
        return rows.map((r) => ({ ...r }));
      },
    ),

    deleteMany: jest.fn(async () => {
      byKey.clear();
      byId.clear();
      return { count: 0 };
    }),

    count: jest.fn(
      async ({
        where,
      }: {
        where?: {
          idempotencyKey?: string;
          status?: PaymentRow['status'];
          retryCount?: { gt: number };
        };
      } = {}) => {
        await Promise.resolve();
        if (where?.idempotencyKey !== undefined) {
          return byKey.has(where.idempotencyKey) ? 1 : 0;
        }
        let rows = [...byId.values()];
        if (where?.status !== undefined) {
          rows = rows.filter((r) => r.status === where.status);
        }
        if (where?.retryCount?.gt !== undefined) {
          const gt = where.retryCount.gt;
          rows = rows.filter((r) => r.retryCount > gt);
        }
        return rows.length;
      },
    ),

    groupBy: jest.fn(
      async ({
        by,
        _count,
      }: {
        by: ['status'];
        _count: { id: true };
      }) => {
        await Promise.resolve();
        void by;
        void _count;
        const tallies = new Map<PaymentRow['status'], number>();
        for (const row of byId.values()) {
          tallies.set(row.status, (tallies.get(row.status) ?? 0) + 1);
        }
        return [...tallies.entries()].map(([status, cnt]) => ({
          status,
          _count: { id: cnt },
        }));
      },
    ),

    aggregate: jest.fn(async () => {
      await Promise.resolve();
      const rows = [...byId.values()];
      const n = rows.length;
      let sum = 0;
      let max = 0;
      for (const row of rows) {
        sum += row.retryCount;
        max = Math.max(max, row.retryCount);
      }
      return {
        _sum: { retryCount: sum },
        _avg: { retryCount: n === 0 ? null : sum / n },
        _max: { retryCount: n === 0 ? null : max },
      };
    }),
  };
}

function mergePaymentPatch(row: PaymentRow, data: Partial<PaymentRow>): PaymentRow {
  return {
    ...row,
    ...(data.amount !== undefined ? { amount: data.amount } : {}),
    ...(data.currency !== undefined ? { currency: data.currency } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
    ...(data.gatewayReferenceId !== undefined ? { gatewayReferenceId: data.gatewayReferenceId } : {}),
    ...(data.retryCount !== undefined ? { retryCount: data.retryCount } : {}),
    ...(data.maxRetries !== undefined ? { maxRetries: data.maxRetries } : {}),
    ...(data.failureReason !== undefined ? { failureReason: data.failureReason } : {}),
    ...(data.lockedUntil !== undefined ? { lockedUntil: data.lockedUntil } : {}),
  };
}

function buildAttemptOps(
  byPaymentIdIndex: Map<string, Map<number, AttemptRow>>,
  attemptsById: Map<string, AttemptRow>,
): {
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findFirst: jest.Mock;
  findUnique: jest.Mock;
  deleteMany: jest.Mock;
} {
  return {
    create: jest.fn(
      async ({
        data,
      }: {
        data: {
          paymentId: string;
          attemptNumber: number;
          status: AttemptRow['status'];
          startedAt?: Date;
        };
      }) => {
        const existingBucket = byPaymentIdIndex.get(data.paymentId);
        if (existingBucket?.has(data.attemptNumber)) {
          throw duplicateAttemptError();
        }

        const id = nextAttemptId();
        const row: AttemptRow = {
          id,
          paymentId: data.paymentId,
          attemptNumber: data.attemptNumber,
          status: data.status,
          gatewayResponse: null,
          errorMessage: null,
          startedAt: data.startedAt ?? new Date(),
          completedAt: null,
        };

        attemptsById.set(id, row);
        const bucket = byPaymentIdIndex.get(data.paymentId) ?? new Map<number, AttemptRow>();
        bucket.set(data.attemptNumber, row);
        byPaymentIdIndex.set(data.paymentId, bucket);

        return { ...row };
      },
    ),

    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<Pick<AttemptRow, 'status' | 'completedAt' | 'errorMessage' | 'gatewayResponse'>>;
      }) => {
        const row = attemptsById.get(where.id);
        if (!row) {
          throw new Error(`Attempt ${where.id} not found`);
        }
        const next: AttemptRow = {
          ...row,
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
          ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
          ...(data.gatewayResponse !== undefined ? { gatewayResponse: data.gatewayResponse } : {}),
        };
        attemptsById.set(where.id, next);
        const bucket = byPaymentIdIndex.get(next.paymentId);
        bucket?.set(next.attemptNumber, next);
        return { ...next };
      },
    ),

    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: {
          id?: string;
          paymentId?: string;
          status?: AttemptRow['status'];
          completedAt?: null;
        };
        data: Partial<
          Pick<AttemptRow, 'status' | 'completedAt' | 'errorMessage' | 'gatewayResponse'>
        >;
      }) => {
        let count = 0;
        for (const row of attemptsById.values()) {
          if (where.id !== undefined && row.id !== where.id) continue;
          if (where.paymentId !== undefined && row.paymentId !== where.paymentId) continue;
          if (where.status !== undefined && row.status !== where.status) continue;
          if (where.completedAt === null && row.completedAt !== null) continue;

          const next: AttemptRow = {
            ...row,
            ...(data.status !== undefined ? { status: data.status } : {}),
            ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
            ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
            ...(data.gatewayResponse !== undefined ? { gatewayResponse: data.gatewayResponse } : {}),
          };
          attemptsById.set(row.id, next);
          const bucket = byPaymentIdIndex.get(next.paymentId);
          bucket?.set(next.attemptNumber, next);
          count += 1;
        }
        return { count };
      },
    ),

    findFirst: jest.fn(
      async ({
        where,
        orderBy,
      }: {
        where: {
          paymentId: string;
          status?: AttemptRow['status'];
          completedAt?: null;
        };
        orderBy: { attemptNumber: 'desc' | 'asc' };
      }) => {
        const bucket = byPaymentIdIndex.get(where.paymentId);
        if (!bucket || bucket.size === 0) return null;
        let rows = [...bucket.values()];
        if (where.status !== undefined) {
          rows = rows.filter((r) => r.status === where.status);
        }
        if (where.completedAt === null) {
          rows = rows.filter((r) => r.completedAt === null);
        }
        rows.sort((a, b) =>
          orderBy.attemptNumber === 'desc'
            ? b.attemptNumber - a.attemptNumber
            : a.attemptNumber - b.attemptNumber,
        );
        const row = rows[0];
        return row ? { ...row } : null;
      },
    ),

    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = attemptsById.get(where.id);
      return row ? { ...row } : null;
    }),

    deleteMany: jest.fn(async () => {
      attemptsById.clear();
      byPaymentIdIndex.clear();
      return { count: 0 };
    }),
  };
}

function buildWebhookEventOps(eventsById: Map<string, WebhookEventRow>): {
  create: jest.Mock;
  findMany: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  deleteMany: jest.Mock;
} {
  return {
    create: jest.fn(
      async ({
        data,
      }: {
        data: {
          gatewayReferenceId: string;
          eventType: string;
          payload: unknown;
          processed?: boolean;
        };
      }) => {
        await Promise.resolve();
        const id = nextWebhookEventId();
        const row: WebhookEventRow = {
          id,
          gatewayReferenceId: data.gatewayReferenceId,
          eventType: data.eventType,
          payload: data.payload,
          processed: data.processed ?? false,
          createdAt: new Date(),
        };
        eventsById.set(id, row);
        return { ...row };
      },
    ),

    findMany: jest.fn(
      async ({
        where,
        orderBy,
      }: {
        where: { gatewayReferenceId?: string; processed?: boolean };
        orderBy?: { createdAt: 'asc' | 'desc' };
      }) => {
        await Promise.resolve();
        let rows = [...eventsById.values()];
        if (where.gatewayReferenceId !== undefined) {
          rows = rows.filter((r) => r.gatewayReferenceId === where.gatewayReferenceId);
        }
        if (where.processed === false) {
          rows = rows.filter((r) => r.processed === false);
        }
        rows.sort((a, b) =>
          orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return rows.map((r) => ({ ...r }));
      },
    ),

    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      await Promise.resolve();
      const row = eventsById.get(where.id);
      return row ? { ...row } : null;
    }),

    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { processed?: boolean; payload?: unknown };
      }) => {
        await Promise.resolve();
        const row = eventsById.get(where.id);
        if (!row) {
          throw new Error(`WebhookEvent ${where.id} not found`);
        }
        const next: WebhookEventRow = {
          ...row,
          ...(data.processed !== undefined ? { processed: data.processed } : {}),
          ...(data.payload !== undefined ? { payload: data.payload } : {}),
        };
        eventsById.set(where.id, next);
        return { ...next };
      },
    ),

    deleteMany: jest.fn(async () => {
      eventsById.clear();
      return { count: 0 };
    }),
  };
}

/**
 * In-memory Prisma-shaped client for HTTP integration tests (no PostgreSQL).
 * Serializes `$transaction` callbacks like Commit ordering under contention.
 */
export function createPaymentTestPrisma(): PrismaClient {
  const byKey = new Map<string, PaymentRow>();
  const byId = new Map<string, PaymentRow>();
  const attemptsById = new Map<string, AttemptRow>();
  const byPaymentIdIndex = new Map<string, Map<number, AttemptRow>>();

  const webhookEventsById = new Map<string, WebhookEventRow>();

  const paymentOps = buildPaymentOps(byKey, byId);
  const attemptOps = buildAttemptOps(byPaymentIdIndex, attemptsById);
  const webhookEventOps = buildWebhookEventOps(webhookEventsById);

  paymentOps.deleteMany.mockImplementation(async () => {
    byKey.clear();
    byId.clear();
    attemptsById.clear();
    byPaymentIdIndex.clear();
    webhookEventsById.clear();
    return { count: 0 };
  });

  attemptOps.deleteMany.mockImplementation(async () => {
    attemptsById.clear();
    byPaymentIdIndex.clear();
    return { count: 0 };
  });

  let txTail: Promise<void> = Promise.resolve();

  const enqueueTransaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    const job = txTail.then(() => fn());
    txTail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  };

  const executeRaw = jest.fn(async () => 0);

  type TransactionShape = {
    payment: typeof paymentOps;
    paymentAttempt: typeof attemptOps;
    webhookEvent: typeof webhookEventOps;
    $executeRaw: jest.Mock;
  };

  const runPaymentTx = async <T>(fn: (tx: TransactionShape) => Promise<T>): Promise<T> => {
    return enqueueTransaction(() =>
      fn({
        payment: paymentOps,
        paymentAttempt: attemptOps,
        webhookEvent: webhookEventOps,
        $executeRaw: executeRaw,
      }),
    );
  };

  const client = {
    payment: paymentOps,
    paymentAttempt: {
      ...attemptOps,
    },
    webhookEvent: webhookEventOps,

    $transaction: jest.fn(
      async (
        fn: (tx: TransactionShape) => Promise<unknown>,
        _options?: unknown,
      ): Promise<unknown> => {
        return runPaymentTx(fn);
      },
    ),

    $connect: jest.fn(async () => undefined),
    $disconnect: jest.fn(async () => undefined),
    $queryRaw: jest.fn(async () => [1]),
    $executeRaw: executeRaw,
  };

  return client as unknown as PrismaClient;
}
