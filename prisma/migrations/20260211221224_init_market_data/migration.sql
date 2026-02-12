-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('DATABENTO', 'FRED', 'YAHOO', 'INTERNAL');

-- CreateEnum
CREATE TYPE "Timeframe" AS ENUM ('M1', 'M5', 'M15', 'H1', 'H4', 'D1');

-- CreateEnum
CREATE TYPE "SignalDirection" AS ENUM ('BULLISH', 'BEARISH');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('FORMING', 'ACTIVE', 'TARGET_HIT', 'STOPPED_OUT');

-- CreateTable
CREATE TABLE "symbols" (
    "code" VARCHAR(16) NOT NULL,
    "displayName" VARCHAR(64) NOT NULL,
    "shortName" VARCHAR(64),
    "description" TEXT,
    "tickSize" DOUBLE PRECISION NOT NULL,
    "dataSource" "DataSource" NOT NULL,
    "dataset" VARCHAR(64),
    "databentoSymbol" VARCHAR(32),
    "fredSymbol" VARCHAR(32),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "symbols_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "market_bars" (
    "id" BIGSERIAL NOT NULL,
    "symbolCode" VARCHAR(16) NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "market_bars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "macro_indicators" (
    "id" BIGSERIAL NOT NULL,
    "indicator" VARCHAR(32) NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "source" "DataSource" NOT NULL,
    "sourceSymbol" VARCHAR(32),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "macro_indicators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measured_move_signals" (
    "id" BIGSERIAL NOT NULL,
    "symbolCode" VARCHAR(16) NOT NULL,
    "timeframe" "Timeframe" NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "direction" "SignalDirection" NOT NULL,
    "status" "SignalStatus" NOT NULL,
    "pointA" DOUBLE PRECISION NOT NULL,
    "pointB" DOUBLE PRECISION NOT NULL,
    "pointC" DOUBLE PRECISION NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "stop" DOUBLE PRECISION NOT NULL,
    "target100" DOUBLE PRECISION NOT NULL,
    "target1236" DOUBLE PRECISION NOT NULL,
    "retracementRatio" DOUBLE PRECISION NOT NULL,
    "quality" INTEGER NOT NULL,
    "source" VARCHAR(32) NOT NULL DEFAULT 'halsey',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "measured_move_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" BIGSERIAL NOT NULL,
    "job" VARCHAR(64) NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),
    "status" VARCHAR(24) NOT NULL DEFAULT 'RUNNING',
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "rowsInserted" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "symbols_source_active_idx" ON "symbols"("dataSource", "isActive");

-- CreateIndex
CREATE INDEX "market_bars_symbol_tf_ts_idx" ON "market_bars"("symbolCode", "timeframe", "timestamp");

-- CreateIndex
CREATE INDEX "market_bars_ts_idx" ON "market_bars"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "market_bars_symbol_tf_ts_key" ON "market_bars"("symbolCode", "timeframe", "timestamp");

-- CreateIndex
CREATE INDEX "macro_indicators_indicator_ts_idx" ON "macro_indicators"("indicator", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "macro_indicators_indicator_ts_key" ON "macro_indicators"("indicator", "timestamp");

-- CreateIndex
CREATE INDEX "mm_signals_symbol_tf_ts_idx" ON "measured_move_signals"("symbolCode", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "mm_signals_dedupe_key" ON "measured_move_signals"("symbolCode", "timeframe", "timestamp", "direction", "entry", "target100");

-- CreateIndex
CREATE INDEX "ingestion_runs_job_started_idx" ON "ingestion_runs"("job", "startedAt");

-- AddForeignKey
ALTER TABLE "market_bars" ADD CONSTRAINT "market_bars_symbolCode_fkey" FOREIGN KEY ("symbolCode") REFERENCES "symbols"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measured_move_signals" ADD CONSTRAINT "measured_move_signals_symbolCode_fkey" FOREIGN KEY ("symbolCode") REFERENCES "symbols"("code") ON DELETE CASCADE ON UPDATE CASCADE;
