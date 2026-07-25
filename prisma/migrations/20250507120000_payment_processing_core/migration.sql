/*
  Replaces the scaffold `Payment` table from `20250506120000_init` with the full
  processing schema (amount/currency enums, attempts, webhooks).
*/

DROP TABLE IF EXISTS "Payment" CASCADE;

CREATE TYPE "PaymentStatus" AS ENUM ('Pending', 'Processing', 'Success', 'Failed');

CREATE TYPE "PaymentAttemptStatus" AS ENUM ('Pending', 'Processing', 'Success', 'Failed');

CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'Pending',
    "gatewayReferenceId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "failureReason" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL,
    "gatewayResponse" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "gatewayReferenceId" TEXT NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_idempotency_key_uidx" ON "Payment"("idempotencyKey");

CREATE UNIQUE INDEX "payment_gateway_reference_uidx" ON "Payment"("gatewayReferenceId");

CREATE INDEX "payment_status_idx" ON "Payment"("status");

CREATE INDEX "payment_status_locked_until_idx" ON "Payment"("status", "lockedUntil");

CREATE INDEX "payment_created_at_idx" ON "Payment"("createdAt");

CREATE INDEX "payment_attempt_payment_id_idx" ON "PaymentAttempt"("paymentId");

CREATE INDEX "payment_attempt_status_idx" ON "PaymentAttempt"("status");

CREATE INDEX "payment_attempt_started_at_idx" ON "PaymentAttempt"("startedAt");

CREATE UNIQUE INDEX "payment_attempt_payment_attempt_no_uidx" ON "PaymentAttempt"("paymentId", "attemptNumber");

CREATE INDEX "webhook_event_gateway_reference_idx" ON "WebhookEvent"("gatewayReferenceId");

CREATE INDEX "webhook_event_processed_created_idx" ON "WebhookEvent"("processed", "createdAt");

CREATE INDEX "webhook_event_gateway_processed_idx" ON "WebhookEvent"("gatewayReferenceId", "processed");

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_paymentId_fkey"
FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payment"
ADD CONSTRAINT "payment_retry_count_non_negative" CHECK ("retryCount" >= 0);

ALTER TABLE "Payment"
ADD CONSTRAINT "payment_max_retries_non_negative" CHECK ("maxRetries" >= 0);

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "payment_attempt_number_positive" CHECK ("attemptNumber" >= 1);

ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "payment_attempt_completed_after_started"
CHECK ("completedAt" IS NULL OR "completedAt" >= "startedAt");
