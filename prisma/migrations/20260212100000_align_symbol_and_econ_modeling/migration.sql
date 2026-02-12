-- CreateEnum
CREATE TYPE "EconCategory" AS ENUM (
    'RATES',
    'INFLATION',
    'LABOR',
    'ACTIVITY',
    'VOLATILITY',
    'COMMODITIES',
    'FX',
    'EQUITY',
    'MONEY',
    'OTHER'
);

-- CreateTable
CREATE TABLE "symbol_mappings" (
    "id" BIGSERIAL NOT NULL,
    "symbolCode" VARCHAR(16) NOT NULL,
    "source" "DataSource" NOT NULL,
    "sourceTable" VARCHAR(64) NOT NULL,
    "sourceSymbol" VARCHAR(64) NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "confidenceScore" DOUBLE PRECISION DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "symbol_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economic_series" (
    "seriesId" VARCHAR(50) NOT NULL,
    "displayName" VARCHAR(200),
    "category" "EconCategory" NOT NULL DEFAULT 'OTHER',
    "source" "DataSource" NOT NULL,
    "sourceSymbol" VARCHAR(50),
    "frequency" VARCHAR(20),
    "units" VARCHAR(32),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "economic_series_pkey" PRIMARY KEY ("seriesId")
);

-- CreateTable
CREATE TABLE "economic_observations_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL,
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "economic_observations_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_source_registry" (
    "sourceId" VARCHAR(64) NOT NULL,
    "sourceName" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "targetTable" VARCHAR(64) NOT NULL,
    "apiProvider" VARCHAR(64) NOT NULL,
    "updateFrequency" VARCHAR(32) NOT NULL,
    "authEnvVar" VARCHAR(64),
    "ingestionScript" VARCHAR(128),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "data_source_registry_pkey" PRIMARY KEY ("sourceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "symbol_mappings_source_key" ON "symbol_mappings"("sourceTable", "sourceSymbol");

-- CreateIndex
CREATE INDEX "symbol_mappings_symbol_source_idx" ON "symbol_mappings"("symbolCode", "source");

-- CreateIndex
CREATE INDEX "economic_series_category_active_idx" ON "economic_series"("category", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "economic_observations_series_date_key" ON "economic_observations_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "economic_observations_series_date_idx" ON "economic_observations_1d"("seriesId", "eventDate");

-- CreateIndex
CREATE INDEX "economic_observations_date_idx" ON "economic_observations_1d"("eventDate");

-- CreateIndex
CREATE INDEX "data_sources_active_idx" ON "data_source_registry"("isActive");

-- AddForeignKey
ALTER TABLE "symbol_mappings" ADD CONSTRAINT "symbol_mappings_symbolCode_fkey"
FOREIGN KEY ("symbolCode") REFERENCES "symbols"("code")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economic_observations_1d" ADD CONSTRAINT "economic_observations_1d_seriesId_fkey"
FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
ON DELETE CASCADE ON UPDATE CASCADE;
