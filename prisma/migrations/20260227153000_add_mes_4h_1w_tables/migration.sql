-- AlterEnum
ALTER TYPE "Timeframe" ADD VALUE 'W1';

-- CreateTable: mkt_futures_mes_4h
CREATE TABLE "mkt_futures_mes_4h" (
    "id" BIGSERIAL NOT NULL,
    "eventTime" TIMESTAMPTZ(6) NOT NULL,
    "open" DECIMAL(18,6) NOT NULL,
    "high" DECIMAL(18,6) NOT NULL,
    "low" DECIMAL(18,6) NOT NULL,
    "close" DECIMAL(18,6) NOT NULL,
    "volume" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mkt_futures_mes_4h_pkey" PRIMARY KEY ("id")
);

-- CreateTable: mkt_futures_mes_1w
CREATE TABLE "mkt_futures_mes_1w" (
    "id" BIGSERIAL NOT NULL,
    "eventDate" DATE NOT NULL,
    "open" DECIMAL(18,6) NOT NULL,
    "high" DECIMAL(18,6) NOT NULL,
    "low" DECIMAL(18,6) NOT NULL,
    "close" DECIMAL(18,6) NOT NULL,
    "volume" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mkt_futures_mes_1w_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mkt_futures_mes_4h_event_time_key" ON "mkt_futures_mes_4h"("eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_futures_mes_1w_event_date_key" ON "mkt_futures_mes_1w"("eventDate");

-- CreateIndex
CREATE INDEX "mkt_futures_mes_1w_date_idx" ON "mkt_futures_mes_1w"("eventDate");
