-- ============================================================================
-- Split Econ Domain Tables (mirrors ZINC Fusion V15 pattern)
-- Creates 9 domain-specific tables and populates from econ_observations_1d
-- ============================================================================

-- econ_rates_1d
CREATE TABLE "econ_rates_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_rates_1d_series_date_key" ON "econ_rates_1d"("seriesId", "eventDate");
CREATE INDEX "econ_rates_1d_date_idx" ON "econ_rates_1d"("eventDate");

-- econ_yields_1d
CREATE TABLE "econ_yields_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_yields_1d_series_date_key" ON "econ_yields_1d"("seriesId", "eventDate");
CREATE INDEX "econ_yields_1d_date_idx" ON "econ_yields_1d"("eventDate");

-- econ_fx_1d
CREATE TABLE "econ_fx_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_fx_1d_series_date_key" ON "econ_fx_1d"("seriesId", "eventDate");
CREATE INDEX "econ_fx_1d_date_idx" ON "econ_fx_1d"("eventDate");

-- econ_vol_indices_1d
CREATE TABLE "econ_vol_indices_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_vol_indices_1d_series_date_key" ON "econ_vol_indices_1d"("seriesId", "eventDate");
CREATE INDEX "econ_vol_indices_1d_date_idx" ON "econ_vol_indices_1d"("eventDate");

-- econ_inflation_1d
CREATE TABLE "econ_inflation_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_inflation_1d_series_date_key" ON "econ_inflation_1d"("seriesId", "eventDate");
CREATE INDEX "econ_inflation_1d_date_idx" ON "econ_inflation_1d"("eventDate");

-- econ_labor_1d
CREATE TABLE "econ_labor_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_labor_1d_series_date_key" ON "econ_labor_1d"("seriesId", "eventDate");
CREATE INDEX "econ_labor_1d_date_idx" ON "econ_labor_1d"("eventDate");

-- econ_activity_1d
CREATE TABLE "econ_activity_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_activity_1d_series_date_key" ON "econ_activity_1d"("seriesId", "eventDate");
CREATE INDEX "econ_activity_1d_date_idx" ON "econ_activity_1d"("eventDate");

-- econ_money_1d
CREATE TABLE "econ_money_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_money_1d_series_date_key" ON "econ_money_1d"("seriesId", "eventDate");
CREATE INDEX "econ_money_1d_date_idx" ON "econ_money_1d"("eventDate");

-- econ_commodities_1d
CREATE TABLE "econ_commodities_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB
);
CREATE UNIQUE INDEX "econ_commodities_1d_series_date_key" ON "econ_commodities_1d"("seriesId", "eventDate");
CREATE INDEX "econ_commodities_1d_date_idx" ON "econ_commodities_1d"("eventDate");

-- ============================================================================
-- Populate from econ_observations_1d
-- ============================================================================

INSERT INTO "econ_rates_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'RATES'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_yields_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'YIELDS'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_fx_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'FX'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_vol_indices_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'VOLATILITY'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_inflation_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'INFLATION'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_labor_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'LABOR'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_activity_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'ACTIVITY'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_money_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'MONEY'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

INSERT INTO "econ_commodities_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
FROM "econ_observations_1d" WHERE "category" = 'COMMODITIES'
ON CONFLICT ("seriesId", "eventDate") DO NOTHING;
