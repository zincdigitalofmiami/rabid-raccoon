-- CreateTable
CREATE TABLE "coverage_check_log" (
    "id" BIGSERIAL NOT NULL,
    "symbol_code" VARCHAR(16) NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "history_days" INTEGER NOT NULL,
    "expected_bars" INTEGER NOT NULL,
    "actual_bars" INTEGER NOT NULL,
    "coverage_pct" DECIMAL(8,4) NOT NULL,
    "passes_threshold" BOOLEAN NOT NULL,
    "threshold_pct" DECIMAL(8,4) NOT NULL,
    "was_activated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "metadata" JSONB,

    CONSTRAINT "coverage_check_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coverage_check_log_symbol_checked_idx" ON "coverage_check_log"("symbol_code", "checked_at");

-- CreateIndex
CREATE INDEX "coverage_check_log_checked_at_idx" ON "coverage_check_log"("checked_at");

-- CreateIndex
CREATE INDEX "coverage_check_log_passes_idx" ON "coverage_check_log"("passes_threshold", "checked_at");
