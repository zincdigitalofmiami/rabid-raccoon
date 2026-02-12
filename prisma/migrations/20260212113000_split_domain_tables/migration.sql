-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM (
    'CPI',
    'PPI',
    'PCE',
    'EMPLOYMENT',
    'GDP',
    'PMI',
    'RETAIL',
    'HOUSING',
    'POLICY',
    'OTHER'
);

-- CreateTable
CREATE TABLE "mkt_futures_1h" (
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

    CONSTRAINT "mkt_futures_1h_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "econ_rates_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_rates_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "econ_yields_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_yields_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "econ_fx_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_fx_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "econ_vol_indices_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_vol_indices_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_indexes_1d" (
    "id" BIGSERIAL NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "eventDate" DATE NOT NULL,
    "open" DOUBLE PRECISION,
    "high" DOUBLE PRECISION,
    "low" DOUBLE PRECISION,
    "close" DOUBLE PRECISION,
    "volume" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'YAHOO',
    "sourceSymbol" VARCHAR(50),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mkt_indexes_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mkt_spot_1d" (
    "id" BIGSERIAL NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'INTERNAL',
    "sourceSymbol" VARCHAR(50),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mkt_spot_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_news_1d" (
    "id" BIGSERIAL NOT NULL,
    "eventDate" DATE NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),
    "headline" TEXT NOT NULL,
    "summary" TEXT,
    "source" VARCHAR(100),
    "region" VARCHAR(64),
    "country" VARCHAR(64),
    "url" TEXT,
    "sentimentScore" DOUBLE PRECISION,
    "impactScore" DOUBLE PRECISION,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "rawPayload" JSONB,

    CONSTRAINT "policy_news_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "macro_reports_1d" (
    "id" BIGSERIAL NOT NULL,
    "reportCode" VARCHAR(50) NOT NULL,
    "reportName" VARCHAR(200) NOT NULL,
    "category" "ReportCategory" NOT NULL DEFAULT 'OTHER',
    "eventDate" DATE NOT NULL,
    "releaseTime" TIMESTAMPTZ(6),
    "periodLabel" VARCHAR(32),
    "actual" DOUBLE PRECISION,
    "forecast" DOUBLE PRECISION,
    "previous" DOUBLE PRECISION,
    "revised" DOUBLE PRECISION,
    "surprise" DOUBLE PRECISION,
    "surprisePct" DOUBLE PRECISION,
    "unit" VARCHAR(24),
    "source" VARCHAR(100),
    "country" VARCHAR(64),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "rawPayload" JSONB,

    CONSTRAINT "macro_reports_1d_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mkt_futures_1h_symbol_time_key" ON "mkt_futures_1h"("symbolCode", "eventTime");

-- CreateIndex
CREATE INDEX "mkt_futures_1h_symbol_time_idx" ON "mkt_futures_1h"("symbolCode", "eventTime");

-- CreateIndex
CREATE INDEX "mkt_futures_1h_time_idx" ON "mkt_futures_1h"("eventTime");

-- CreateIndex
CREATE UNIQUE INDEX "econ_rates_1d_series_date_key" ON "econ_rates_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_rates_1d_series_date_idx" ON "econ_rates_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_rates_1d_date_idx" ON "econ_rates_1d"("eventDate");

-- CreateIndex
CREATE UNIQUE INDEX "econ_yields_1d_series_date_key" ON "econ_yields_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_yields_1d_series_date_idx" ON "econ_yields_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_yields_1d_date_idx" ON "econ_yields_1d"("eventDate");

-- CreateIndex
CREATE UNIQUE INDEX "econ_fx_1d_series_date_key" ON "econ_fx_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_fx_1d_series_date_idx" ON "econ_fx_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_fx_1d_date_idx" ON "econ_fx_1d"("eventDate");

-- CreateIndex
CREATE UNIQUE INDEX "econ_vol_indices_1d_series_date_key" ON "econ_vol_indices_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_vol_indices_1d_series_date_idx" ON "econ_vol_indices_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "econ_vol_indices_1d_date_idx" ON "econ_vol_indices_1d"("eventDate");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_indexes_1d_symbol_date_key" ON "mkt_indexes_1d"("symbol", "eventDate");

-- CreateIndex
CREATE INDEX "mkt_indexes_1d_symbol_date_idx" ON "mkt_indexes_1d"("symbol", "eventDate");

-- CreateIndex
CREATE INDEX "mkt_indexes_1d_date_idx" ON "mkt_indexes_1d"("eventDate");

-- CreateIndex
CREATE UNIQUE INDEX "mkt_spot_1d_symbol_date_key" ON "mkt_spot_1d"("symbol", "eventDate");

-- CreateIndex
CREATE INDEX "mkt_spot_1d_symbol_date_idx" ON "mkt_spot_1d"("symbol", "eventDate");

-- CreateIndex
CREATE INDEX "mkt_spot_1d_date_idx" ON "mkt_spot_1d"("eventDate");

-- CreateIndex
CREATE INDEX "policy_news_1d_date_idx" ON "policy_news_1d"("eventDate");

-- CreateIndex
CREATE INDEX "policy_news_1d_source_idx" ON "policy_news_1d"("source");

-- CreateIndex
CREATE INDEX "policy_news_1d_tags_idx" ON "policy_news_1d" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "macro_reports_1d_code_date_key" ON "macro_reports_1d"("reportCode", "eventDate");

-- CreateIndex
CREATE INDEX "macro_reports_1d_date_idx" ON "macro_reports_1d"("eventDate");

-- CreateIndex
CREATE INDEX "macro_reports_1d_category_date_idx" ON "macro_reports_1d"("category", "eventDate");

-- AddForeignKey
ALTER TABLE "mkt_futures_1h" ADD CONSTRAINT "mkt_futures_1h_symbolCode_fkey"
FOREIGN KEY ("symbolCode") REFERENCES "symbols"("code")
ON DELETE CASCADE ON UPDATE CASCADE;
