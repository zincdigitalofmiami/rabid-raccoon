-- CreateTable
CREATE TABLE "mes_prices_1h" (
    "id" BIGSERIAL NOT NULL,
    "eventTime" TIMESTAMPTZ(6) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mes_prices_1h_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "futures_ex_mes_1h" (
    "id" BIGSERIAL NOT NULL,
    "symbolCode" VARCHAR(16) NOT NULL,
    "eventTime" TIMESTAMPTZ(6) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT,
    "openInterest" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "futures_ex_mes_1h_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mes_prices_1h_event_time_key" ON "mes_prices_1h"("eventTime");

-- CreateIndex
CREATE INDEX "mes_prices_1h_event_time_idx" ON "mes_prices_1h"("eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "futures_ex_mes_1h_symbol_time_key" ON "futures_ex_mes_1h"("symbolCode", "eventTime");

-- CreateIndex
CREATE INDEX "futures_ex_mes_1h_symbol_time_idx" ON "futures_ex_mes_1h"("symbolCode", "eventTime");

-- CreateIndex
CREATE INDEX "futures_ex_mes_1h_time_idx" ON "futures_ex_mes_1h"("eventTime");

-- AddForeignKey
ALTER TABLE "futures_ex_mes_1h" ADD CONSTRAINT "futures_ex_mes_1h_symbolCode_fkey"
FOREIGN KEY ("symbolCode") REFERENCES "symbols"("code")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Enforce MES isolation from non-MES futures table.
ALTER TABLE "futures_ex_mes_1h"
ADD CONSTRAINT "futures_ex_mes_1h_symbol_not_mes_chk"
CHECK ("symbolCode" <> 'MES');

-- Migrate existing rows from previous unified futures table if present.
INSERT INTO "mes_prices_1h" (
    "eventTime", "open", "high", "low", "close", "volume", "source", "sourceDataset",
    "sourceSchema", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
)
SELECT
    "eventTime", "open", "high", "low", "close", "volume", "source", "sourceDataset",
    "sourceSchema", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "mkt_futures_1h"
WHERE "symbolCode" = 'MES'
ON CONFLICT ("eventTime") DO NOTHING;

INSERT INTO "futures_ex_mes_1h" (
    "symbolCode", "eventTime", "open", "high", "low", "close", "volume", "openInterest", "source",
    "sourceDataset", "sourceSchema", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
)
SELECT
    "symbolCode", "eventTime", "open", "high", "low", "close", "volume", "openInterest", "source",
    "sourceDataset", "sourceSchema", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "mkt_futures_1h"
WHERE "symbolCode" <> 'MES'
ON CONFLICT ("symbolCode", "eventTime") DO NOTHING;

-- Remove deprecated tables from active path.
DROP TABLE IF EXISTS "mkt_futures_1h";
DROP TABLE IF EXISTS "market_bars";
