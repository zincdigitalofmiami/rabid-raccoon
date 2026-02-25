-- CreateTable: mkt_options_agg_1d
-- Daily aggregated options metrics per parent symbol (statistics-derived)
CREATE TABLE "mkt_options_agg_1d" (
    "id" BIGSERIAL NOT NULL,
    "parentSymbol" VARCHAR(16) NOT NULL,
    "eventDate" DATE NOT NULL,
    "totalVolume" BIGINT,
    "totalOI" BIGINT,
    "settlement" DECIMAL(18,6),
    "avgIV" DECIMAL(10,6),
    "contractCount" INTEGER,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mkt_options_agg_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable: mkt_options_ohlcv_1d
-- Daily OHLCV aggregated to parent symbol level
CREATE TABLE "mkt_options_ohlcv_1d" (
    "id" BIGSERIAL NOT NULL,
    "parentSymbol" VARCHAR(16) NOT NULL,
    "eventDate" DATE NOT NULL,
    "totalVolume" BIGINT,
    "contractCount" INTEGER,
    "avgClose" DECIMAL(18,6),
    "maxHigh" DECIMAL(18,6),
    "minLow" DECIMAL(18,6),
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mkt_options_ohlcv_1d_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mkt_options_agg_1d_parent_date_key" ON "mkt_options_agg_1d"("parentSymbol", "eventDate");
CREATE INDEX "mkt_options_agg_1d_date_idx" ON "mkt_options_agg_1d"("eventDate");
CREATE INDEX "mkt_options_agg_1d_parent_idx" ON "mkt_options_agg_1d"("parentSymbol");

CREATE UNIQUE INDEX "mkt_options_ohlcv_1d_parent_date_key" ON "mkt_options_ohlcv_1d"("parentSymbol", "eventDate");
CREATE INDEX "mkt_options_ohlcv_1d_date_idx" ON "mkt_options_ohlcv_1d"("eventDate");
CREATE INDEX "mkt_options_ohlcv_1d_parent_idx" ON "mkt_options_ohlcv_1d"("parentSymbol");
