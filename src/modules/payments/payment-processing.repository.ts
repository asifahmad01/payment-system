import { Prisma, PrismaClient } from '@prisma/client';
import type { PaymentWebhookBody } from '../webhooks/payment-webhook.schema';
import type { Payment, PaymentAttempt } from './payment.types';

const DEFAULT_LEASE_MS = 60_000;

export type ClaimPaymentResult =
  | { kind: 'not_found' }
  | { kind: 'already_success'; payment: Payment }
  | { kind: 'terminal_failed'; payment: Payment }
  | { kind: 'busy'; payment: Payment }
  | { kind: 'claimed'; payment: Payment; attempt: PaymentAttempt };

export type PaymentWebhookIngestResult = {
  httpStatus: 200 | 202;
  outcome: string;
  webhookEventId: string;
  payment?: Payment;
};

async function lockPaymentRowById(
  tx: Prisma.TransactionClient,
  paymentId: string,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`);
}

async function lockPaymentRowByGatewayReference(
  tx: Prisma.TransactionClient,
  gatewayReferenceId: string,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT 1 FROM "Payment" WHERE "gatewayReferenceId" = ${gatewayReferenceId} FOR UPDATE`,
  );
}

export class PaymentProcessingRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leaseMs: number = DEFAULT_LEASE_MS,
  ) {}

  async claimPaymentForProcessing(paymentId: string): Promise<ClaimPaymentResult> {
    return this.prisma.$transaction(
      async (tx) => {
        await lockPaymentRowById(tx, paymentId);

        const payment = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!payment) {
          return { kind: 'not_found' };
        }

        if (payment.status === 'Success') {
          return { kind: 'already_success', payment };
        }

        if (payment.status === 'Failed') {
          return { kind: 'terminal_failed', payment };
        }

        const now = new Date();

        if (payment.status === 'Processing') {
          if (payment.lockedUntil && payment.lockedUntil > now) {
            return { kind: 'busy', payment };
          }
          await this.releaseStaleProcessingLease(tx, payment.id, now);
        }

        const lockedUntil = new Date(now.getTime() + this.leaseMs);
        const transitioned = await tx.payment.updateMany({
          where: { id: paymentId, status: 'Pending' },
          data: {
            status: 'Processing',
            lockedUntil,
          },
        });

        if (transitioned.count === 0) {
          const current = await tx.payment.findUnique({ where: { id: paymentId } });
          if (!current) {
            return { kind: 'not_found' };
          }
          if (current.status === 'Success') {
            return { kind: 'already_success', payment: current };
          }
          return { kind: 'busy', payment: current };
        }

        const latestAttempt = await tx.paymentAttempt.findFirst({
          where: { paymentId },
          orderBy: { attemptNumber: 'desc' },
        });
        const attemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;

        const attempt = await tx.paymentAttempt.create({
          data: {
            paymentId,
            attemptNumber,
            status: 'Processing',
          },
        });

        const updatedPayment = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!updatedPayment) {
          throw new Error(`Payment ${paymentId} missing after claim transition`);
        }

        return { kind: 'claimed', payment: updatedPayment, attempt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Writes the gateway reference while still Processing so webhook correlation can race safely
   * with {@link finalizeSuccess} — both paths converge on terminal Success.
   */
  async attachGatewayReferenceForProcessingPayment(
    paymentId: string,
    gatewayReferenceId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockPaymentRowById(tx, paymentId);
      await tx.payment.updateMany({
        where: {
          id: paymentId,
          status: 'Processing',
          gatewayReferenceId: null,
        },
        data: { gatewayReferenceId },
      });
    });
    await this.replayQueuedWebhooksForGatewayReference(gatewayReferenceId);
  }

  async finalizeSuccess(
    paymentId: string,
    attemptId: string,
    gatewayReferenceId: string,
  ): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      await lockPaymentRowById(tx, paymentId);

      let payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) {
        throw new Error(`Payment ${paymentId} not found during finalize`);
      }

      if (payment.status === 'Success') {
        return payment;
      }

      if (payment.status !== 'Processing') {
        return payment;
      }

      const completedAt = new Date();
      await tx.paymentAttempt.updateMany({
        where: {
          id: attemptId,
          paymentId,
          status: 'Processing',
        },
        data: {
          status: 'Success',
          completedAt,
          errorMessage: null,
          gatewayResponse: { outcome: 'success', gatewayReferenceId },
        },
      });

      await tx.payment.updateMany({
        where: {
          id: paymentId,
          status: 'Processing',
        },
        data: {
          status: 'Success',
          gatewayReferenceId,
          lockedUntil: null,
          failureReason: null,
        },
      });

      payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) {
        throw new Error(`Payment ${paymentId} missing after success finalize`);
      }
      return payment;
    });
  }

  /** Persists the callback and applies safe payment transitions (duplicate- and early-safe). */
  async ingestPaymentWebhook(payload: PaymentWebhookBody): Promise<PaymentWebhookIngestResult> {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.webhookEvent.create({
        data: {
          gatewayReferenceId: payload.gatewayReferenceId,
          eventType: `payment.${payload.status}`,
          payload: payload as unknown as Prisma.InputJsonValue,
          processed: false,
        },
      });

      await lockPaymentRowByGatewayReference(tx, payload.gatewayReferenceId);

      const payment = await tx.payment.findUnique({
        where: { gatewayReferenceId: payload.gatewayReferenceId },
      });

      if (!payment) {
        return {
          httpStatus: 202,
          outcome: 'queued_early_no_payment',
          webhookEventId: event.id,
        };
      }

      const applied =
        payload.status === 'success'
          ? await this.applyWebhookSuccessForPayment(tx, payment, payload.gatewayReferenceId)
          : await this.applyWebhookFailureForPayment(tx, payment, payload);

      await this.markWebhookEventHandled(tx, event.id, payload, applied.outcomeKey);

      const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
      return {
        httpStatus: 200,
        outcome: applied.outcomeKey,
        webhookEventId: event.id,
        payment: fresh ?? applied.payment,
      };
    });
  }

  /** Processes webhook rows stored before the payment row carried `gatewayReferenceId`. */
  async replayQueuedWebhooksForGatewayReference(gatewayReferenceId: string): Promise<void> {
    const pending = await this.prisma.webhookEvent.findMany({
      where: { gatewayReferenceId, processed: false },
      orderBy: { createdAt: 'asc' },
    });

    for (const ev of pending) {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.webhookEvent.findUnique({ where: { id: ev.id } });
        if (!row || row.processed) {
          return;
        }

        const payload = row.payload as PaymentWebhookBody;
        if (
          !payload ||
          typeof payload.gatewayReferenceId !== 'string' ||
          (payload.status !== 'success' && payload.status !== 'failed')
        ) {
          await tx.webhookEvent.update({
            where: { id: row.id },
            data: {
              processed: true,
              payload: {
                ...(typeof row.payload === 'object' && row.payload !== null
                  ? (row.payload as object)
                  : {}),
                _handlerOutcome: 'invalid_payload_skipped',
              } as Prisma.InputJsonValue,
            },
          });
          return;
        }

        await lockPaymentRowByGatewayReference(tx, gatewayReferenceId);

        const payment = await tx.payment.findUnique({
          where: { gatewayReferenceId },
        });

        if (!payment) {
          return;
        }

        const applied =
          payload.status === 'success'
            ? await this.applyWebhookSuccessForPayment(tx, payment, payload.gatewayReferenceId)
            : await this.applyWebhookFailureForPayment(tx, payment, payload);

        await this.markWebhookEventHandled(tx, row.id, payload, applied.outcomeKey);
      });
    }
  }

  private async markWebhookEventHandled(
    tx: Prisma.TransactionClient,
    eventId: string,
    payload: PaymentWebhookBody,
    handlerOutcome: string,
  ): Promise<void> {
    const enriched: Record<string, Prisma.JsonValue> = {
      gatewayReferenceId: payload.gatewayReferenceId,
      status: payload.status,
      _handlerOutcome: handlerOutcome,
    };
    if (payload.reason !== undefined) {
      enriched.reason = payload.reason;
    }

    await tx.webhookEvent.update({
      where: { id: eventId },
      data: {
        processed: true,
        payload: enriched,
      },
    });
  }

  private async applyWebhookSuccessForPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
    gatewayReferenceId: string,
  ): Promise<{ outcomeKey: string; payment: Payment }> {
    if (payment.status === 'Success') {
      return { outcomeKey: 'already_success', payment };
    }

    const completedAt = new Date();

    if (payment.status === 'Failed') {
      await tx.paymentAttempt.updateMany({
        where: {
          paymentId: payment.id,
          status: 'Processing',
          completedAt: null,
        },
        data: {
          status: 'Success',
          completedAt,
          errorMessage: null,
          gatewayResponse: {
            outcome: 'success',
            source: 'webhook',
            gatewayReferenceId,
          },
        },
      });

      await tx.payment.updateMany({
        where: { id: payment.id, status: 'Failed' },
        data: {
          status: 'Success',
          gatewayReferenceId,
          lockedUntil: null,
          failureReason: null,
        },
      });

      const updated = await tx.payment.findUnique({ where: { id: payment.id } });
      return {
        outcomeKey: 'applied_success_recovered_from_failed',
        payment: updated!,
      };
    }

    await tx.paymentAttempt.updateMany({
      where: {
        paymentId: payment.id,
        status: 'Processing',
        completedAt: null,
      },
      data: {
        status: 'Success',
        completedAt,
        errorMessage: null,
        gatewayResponse: {
          outcome: 'success',
          source: 'webhook',
          gatewayReferenceId,
        },
      },
    });

    await tx.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: ['Pending', 'Processing'] },
      },
      data: {
        status: 'Success',
        gatewayReferenceId,
        lockedUntil: null,
        failureReason: null,
      },
    });

    const updated = await tx.payment.findUnique({ where: { id: payment.id } });
    return { outcomeKey: 'applied_success', payment: updated! };
  }

  private async applyWebhookFailureForPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
    payload: PaymentWebhookBody,
  ): Promise<{ outcomeKey: string; payment: Payment }> {
    const gatewayReferenceId = payload.gatewayReferenceId;
    const msg = payload.reason ?? 'webhook_failed';

    if (payment.status === 'Success') {
      return { outcomeKey: 'ignored_failed_vs_success_conflict', payment };
    }

    if (payment.status === 'Failed') {
      return { outcomeKey: 'already_failed', payment };
    }

    const completedAt = new Date();

    const openAttempt = await tx.paymentAttempt.findFirst({
      where: {
        paymentId: payment.id,
        status: 'Processing',
        completedAt: null,
      },
      orderBy: { attemptNumber: 'desc' },
    });

    if (openAttempt) {
      await tx.paymentAttempt.updateMany({
        where: {
          id: openAttempt.id,
          paymentId: payment.id,
          status: 'Processing',
        },
        data: {
          status: 'Failed',
          completedAt,
          errorMessage: msg,
          gatewayResponse: {
            outcome: 'failure',
            source: 'webhook',
            gatewayReferenceId,
          },
        },
      });

      const newRetryCount = payment.retryCount + 1;
      const terminal = newRetryCount >= payment.maxRetries;

      await tx.payment.updateMany({
        where: { id: payment.id, status: 'Processing' },
        data: {
          retryCount: newRetryCount,
          status: terminal ? 'Failed' : 'Pending',
          lockedUntil: null,
          failureReason: msg,
        },
      });
    } else {
      const newRetryCount = payment.retryCount + 1;
      const terminal = newRetryCount >= payment.maxRetries;

      await tx.payment.updateMany({
        where: { id: payment.id, status: 'Pending' },
        data: {
          retryCount: newRetryCount,
          status: terminal ? 'Failed' : 'Pending',
          lockedUntil: null,
          failureReason: msg,
        },
      });
    }

    const updated = await tx.payment.findUnique({ where: { id: payment.id } });
    return { outcomeKey: 'applied_failed', payment: updated! };
  }

  async finalizeProcessingFailure(params: {
    paymentId: string;
    attemptId: string;
    gatewayReferenceId?: string | null;
    gatewayResponse?: Prisma.JsonValue;
    errorMessage: string;
  }): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      await lockPaymentRowById(tx, params.paymentId);

      let payment = await tx.payment.findUnique({ where: { id: params.paymentId } });
      if (!payment) {
        throw new Error(`Payment ${params.paymentId} not found during finalize`);
      }

      if (payment.status === 'Success') {
        return payment;
      }

      if (payment.status !== 'Processing') {
        return payment;
      }

      const completedAt = new Date();

      await tx.paymentAttempt.updateMany({
        where: {
          id: params.attemptId,
          paymentId: params.paymentId,
          status: 'Processing',
        },
        data: {
          status: 'Failed',
          completedAt,
          errorMessage: params.errorMessage,
          gatewayResponse: params.gatewayResponse ?? undefined,
        },
      });

      const newRetryCount = payment.retryCount + 1;
      const terminal = newRetryCount >= payment.maxRetries;

      await tx.payment.updateMany({
        where: {
          id: params.paymentId,
          status: 'Processing',
        },
        data: {
          retryCount: newRetryCount,
          status: terminal ? 'Failed' : 'Pending',
          lockedUntil: null,
          failureReason: params.errorMessage,
        },
      });

      payment = await tx.payment.findUnique({ where: { id: params.paymentId } });
      if (!payment) {
        throw new Error(`Payment ${params.paymentId} missing after failure finalize`);
      }
      return payment;
    });
  }

  /** Lightweight read for gateway probes outside a DB transaction (recovery orchestration). */
  loadPaymentRowForRecoveryProbe(paymentId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { id: paymentId } });
  }

  /**
   * Lease-expired `Processing` rows: `lockedUntil` must be non-null and far enough in the past.
   */
  async listStuckProcessingPaymentIds(params: {
    minIdleAfterLeaseMs: number;
    limit: number;
  }): Promise<string[]> {
    const cutoff = new Date(Date.now() - params.minIdleAfterLeaseMs);
    const rows = await this.prisma.payment.findMany({
      where: {
        status: 'Processing',
        lockedUntil: { not: null, lte: cutoff },
      },
      select: { id: true },
      orderBy: { lockedUntil: 'asc' },
      take: params.limit,
    });
    return rows.map((r) => r.id);
  }

  /**
   * Idempotent: re-checks terminal Success / stale lease inside a locked transaction.
   */
  async applyStaleProcessingRecovery(params: {
    paymentId: string;
    minIdleAfterLeaseMs: number;
    decision: 'gateway_success' | 'local_failure';
    failureReason?: string;
  }): Promise<{ outcome: string; payment: Payment } | null> {
    return this.prisma.$transaction(async (tx) => {
      await lockPaymentRowById(tx, params.paymentId);

      const payment = await tx.payment.findUnique({ where: { id: params.paymentId } });
      if (!payment) {
        return null;
      }

      if (payment.status === 'Success') {
        return { outcome: 'skipped_already_success', payment };
      }

      if (payment.status !== 'Processing') {
        return { outcome: 'skipped_not_processing', payment };
      }

      const cutoffTime = Date.now() - params.minIdleAfterLeaseMs;
      if (!payment.lockedUntil || payment.lockedUntil.getTime() > cutoffTime) {
        return { outcome: 'skipped_not_stuck_yet', payment };
      }

      const failureReason = params.failureReason ?? 'recovery_stale_processing';

      if (params.decision === 'gateway_success') {
        if (!payment.gatewayReferenceId) {
          const r = await this.applyStaleLeaseFailure(tx, payment, failureReason);
          return { outcome: 'applied_local_failure', payment: r.payment };
        }

        const r = await this.applyWebhookSuccessForPayment(tx, payment, payment.gatewayReferenceId);
        return { outcome: 'applied_gateway_success', payment: r.payment };
      }

      const r = await this.applyStaleLeaseFailure(tx, payment, failureReason);
      return { outcome: 'applied_local_failure', payment: r.payment };
    });
  }

  private async applyStaleLeaseFailure(
    tx: Prisma.TransactionClient,
    payment: Payment,
    msg: string,
  ): Promise<{ payment: Payment }> {
    const gatewayReferenceId = payment.gatewayReferenceId ?? undefined;
    const completedAt = new Date();

    const openAttempt = await tx.paymentAttempt.findFirst({
      where: {
        paymentId: payment.id,
        status: 'Processing',
        completedAt: null,
      },
      orderBy: { attemptNumber: 'desc' },
    });

    if (openAttempt) {
      await tx.paymentAttempt.updateMany({
        where: {
          id: openAttempt.id,
          paymentId: payment.id,
          status: 'Processing',
        },
        data: {
          status: 'Failed',
          completedAt,
          errorMessage: msg,
          gatewayResponse: gatewayReferenceId
            ? {
                outcome: 'failure',
                source: 'recovery',
                gatewayReferenceId,
              }
            : { outcome: 'failure', source: 'recovery' },
        },
      });

      const newRetryCount = payment.retryCount + 1;
      const terminal = newRetryCount >= payment.maxRetries;

      await tx.payment.updateMany({
        where: { id: payment.id, status: 'Processing' },
        data: {
          retryCount: newRetryCount,
          status: terminal ? 'Failed' : 'Pending',
          lockedUntil: null,
          failureReason: msg,
        },
      });
    } else {
      const newRetryCount = payment.retryCount + 1;
      const terminal = newRetryCount >= payment.maxRetries;

      await tx.payment.updateMany({
        where: { id: payment.id, status: 'Processing' },
        data: {
          retryCount: newRetryCount,
          status: terminal ? 'Failed' : 'Pending',
          lockedUntil: null,
          failureReason: msg,
        },
      });
    }

    const updated = await tx.payment.findUnique({ where: { id: payment.id } });
    return { payment: updated! };
  }

  private async releaseStaleProcessingLease(
    tx: Prisma.TransactionClient,
    paymentId: string,
    now: Date,
  ): Promise<void> {
    await tx.paymentAttempt.updateMany({
      where: {
        paymentId,
        status: 'Processing',
        completedAt: null,
      },
      data: {
        status: 'Failed',
        completedAt: now,
        errorMessage: 'processing_lease_expired',
      },
    });

    await tx.payment.updateMany({
      where: { id: paymentId, status: 'Processing' },
      data: {
        status: 'Pending',
        lockedUntil: null,
      },
    });
  }
}
