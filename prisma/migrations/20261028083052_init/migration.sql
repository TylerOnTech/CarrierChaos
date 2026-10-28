-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'processing', 'completed', 'failed', 'dead_lettered', 'cancelled');

-- CreateEnum
CREATE TYPE "attempt_outcome" AS ENUM ('succeeded', 'retryable_error', 'permanent_error', 'abandoned');

-- CreateEnum
CREATE TYPE "experiment_status" AS ENUM ('running', 'completed');

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "deadline_at" TIMESTAMP(3),
    "replay_count" INTEGER NOT NULL DEFAULT 0,
    "execution_id" UUID,
    "execution_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "circuit_deferrals" INTEGER NOT NULL DEFAULT 0,
    "rate_limit_deferrals" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error_kind" TEXT,
    "last_error_message" TEXT,
    "terminal_reason" TEXT,
    "result_policy_record_id" UUID,
    "experiment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "enqueued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_attempts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "run" INTEGER NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "execution_id" UUID NOT NULL,
    "worker_id" TEXT NOT NULL,
    "outcome" "attempt_outcome",
    "error_kind" TEXT,
    "http_status" INTEGER,
    "error_message" TEXT,
    "retry_delay_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,

    CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letters" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "run" INTEGER NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "error_kind" TEXT,
    "reason" TEXT NOT NULL,
    "message" TEXT,
    "attempts" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayed_at" TIMESTAMP(3),

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_records" (
    "id" UUID NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fetch_count" INTEGER NOT NULL DEFAULT 1,
    "first_job_id" UUID NOT NULL,
    "last_job_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiments" (
    "id" UUID NOT NULL,
    "scenario" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "status" "experiment_status" NOT NULL DEFAULT 'running',
    "config" JSONB NOT NULL,
    "summary" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circuit_breaker_transitions" (
    "id" UUID NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circuit_breaker_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_status_created_at_idx" ON "jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "jobs_carrier_id_status_idx" ON "jobs"("carrier_id", "status");

-- CreateIndex
CREATE INDEX "jobs_experiment_id_idx" ON "jobs"("experiment_id");

-- CreateIndex
CREATE INDEX "jobs_created_at_id_idx" ON "jobs"("created_at", "id");

-- CreateIndex
CREATE INDEX "job_attempts_started_at_idx" ON "job_attempts"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_attempts_job_id_run_attempt_number_key" ON "job_attempts"("job_id", "run", "attempt_number");

-- CreateIndex
CREATE INDEX "dead_letters_replayed_at_created_at_idx" ON "dead_letters"("replayed_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letters_job_id_run_key" ON "dead_letters"("job_id", "run");

-- CreateIndex
CREATE UNIQUE INDEX "policy_records_carrier_id_policy_id_key" ON "policy_records"("carrier_id", "policy_id");

-- CreateIndex
CREATE INDEX "circuit_breaker_transitions_carrier_id_occurred_at_idx" ON "circuit_breaker_transitions"("carrier_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_result_policy_record_id_fkey" FOREIGN KEY ("result_policy_record_id") REFERENCES "policy_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "experiments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
