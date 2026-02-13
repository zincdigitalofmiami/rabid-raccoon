-- ============================================================================
-- COMPREHENSIVE SCHEMA REFACTOR MIGRATION
-- ============================================================================
-- This migration performs the following changes:
-- 1. Convert Float fields to Decimal with proper precision
-- 2. Consolidate 8 econ tables into EconObservation1d
-- 3. Rename MktIndexes1d.symbol and MktSpot1d.symbol to symbolCode
-- 4. Add enums for BhgSetup (BhgPhase, SignalDirection, Timeframe)
-- 5. Convert IngestionRun.status to enum
-- 6. Add updatedAt to MesModelRegistry
-- 7. Simplify MeasuredMoveSignal dedupe key
-- 8. Remove redundant indexes (UNIQUE already creates B-tree index)
-- ============================================================================

-- ============================================================================
-- STEP 1: Create new enums
-- ============================================================================

-- Create BhgPhase enum
DO $$ BEGIN
    CREATE TYPE "BhgPhase" AS ENUM ('TOUCHED', 'HOOKED', 'GO_FIRED', 'EXPIRED', 'STOPPED', 'TP1_HIT', 'TP2_HIT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create SignalDirection enum
DO $$ BEGIN
    CREATE TYPE "SignalDirection" AS ENUM ('BULLISH', 'BEARISH');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Timeframe enum
DO $$ BEGIN
    CREATE TYPE "Timeframe" AS ENUM ('M1', 'M5', 'M15', 'H1', 'H4', 'D1');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create IngestionStatus enum
DO $$ BEGIN
    CREATE TYPE "IngestionStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- STEP 2: Convert Float to Decimal for symbols table
-- ============================================================================

ALTER TABLE "symbols" ALTER COLUMN "tickSize" TYPE DECIMAL(18,6) USING "tickSize"::DECIMAL(18,6);

-- ============================================================================
-- STEP 3: Convert Float to Decimal for symbol_mappings table
-- ============================================================================

ALTER TABLE "symbol_mappings" ALTER COLUMN "confidenceScore" TYPE DECIMAL(5,4) USING "confidenceScore"::DECIMAL(5,4);
ALTER TABLE "symbol_mappings" ALTER COLUMN "confidenceScore" SET DEFAULT 1;

-- ============================================================================
-- STEP 4: Convert Float to Decimal for MES price tables
-- ============================================================================

-- mes_prices_1h
ALTER TABLE "mes_prices_1h" ALTER COLUMN "open" TYPE DECIMAL(18,6) USING "open"::DECIMAL(18,6);
ALTER TABLE "mes_prices_1h" ALTER COLUMN "high" TYPE DECIMAL(18,6) USING "high"::DECIMAL(18,6);
ALTER TABLE "mes_prices_1h" ALTER COLUMN "low" TYPE DECIMAL(18,6) USING "low"::DECIMAL(18,6);
ALTER TABLE "mes_prices_1h" ALTER COLUMN "close" TYPE DECIMAL(18,6) USING "close"::DECIMAL(18,6);

-- Drop redundant index (unique constraint already creates index)
DROP INDEX IF EXISTS "mes_prices_1h_event_time_idx";

-- mes_prices_1m
ALTER TABLE "mes_prices_1m" ALTER COLUMN "open" TYPE DECIMAL(18,6) USING "open"::DECIMAL(18,6);
ALTER TABLE "mes_prices_1m" ALTER COLUMN "high" TYPE DECIMAL(18,6) USING "high"::DECIMAL(18,6);
ALTER TABLE "mes_prices_1m" ALTER COLUMN "low" TYPE DECIMAL(18,6) USING "low"::DECIMAL(18,6);
ALTER TABLE "mes_prices_1m" ALTER COLUMN "close" TYPE DECIMAL(18,6) USING "close"::DECIMAL(18,6);

-- Drop redundant index
DROP INDEX IF EXISTS "mes_prices_1m_event_time_idx";

-- mes_prices_15m
ALTER TABLE "mes_prices_15m" ALTER COLUMN "open" TYPE DECIMAL(18,6) USING "open"::DECIMAL(18,6);
ALTER TABLE "mes_prices_15m" ALTER COLUMN "high" TYPE DECIMAL(18,6) USING "high"::DECIMAL(18,6);
ALTER TABLE "mes_prices_15m" ALTER COLUMN "low" TYPE DECIMAL(18,6) USING "low"::DECIMAL(18,6);
ALTER TABLE "mes_prices_15m" ALTER COLUMN "close" TYPE DECIMAL(18,6) USING "close"::DECIMAL(18,6);

-- Drop redundant index
DROP INDEX IF EXISTS "mes_prices_15m_event_time_idx";

-- ============================================================================
-- STEP 5: Convert Float to Decimal for futures tables
-- ============================================================================

-- futures_ex_mes_1h
ALTER TABLE "futures_ex_mes_1h" ALTER COLUMN "open" TYPE DECIMAL(18,6) USING "open"::DECIMAL(18,6);
ALTER TABLE "futures_ex_mes_1h" ALTER COLUMN "high" TYPE DECIMAL(18,6) USING "high"::DECIMAL(18,6);
ALTER TABLE "futures_ex_mes_1h" ALTER COLUMN "low" TYPE DECIMAL(18,6) USING "low"::DECIMAL(18,6);
ALTER TABLE "futures_ex_mes_1h" ALTER COLUMN "close" TYPE DECIMAL(18,6) USING "close"::DECIMAL(18,6);

-- Drop redundant index
DROP INDEX IF EXISTS "futures_ex_mes_1h_symbol_time_idx";

-- futures_ex_mes_1d
ALTER TABLE "futures_ex_mes_1d" ALTER COLUMN "open" TYPE DECIMAL(18,6) USING "open"::DECIMAL(18,6);
ALTER TABLE "futures_ex_mes_1d" ALTER COLUMN "high" TYPE DECIMAL(18,6) USING "high"::DECIMAL(18,6);
ALTER TABLE "futures_ex_mes_1d" ALTER COLUMN "low" TYPE DECIMAL(18,6) USING "low"::DECIMAL(18,6);
ALTER TABLE "futures_ex_mes_1d" ALTER COLUMN "close" TYPE DECIMAL(18,6) USING "close"::DECIMAL(18,6);

-- Drop redundant index
DROP INDEX IF EXISTS "futures_ex_mes_1d_symbol_date_idx";

-- ============================================================================
-- STEP 6: Create consolidated econ_observations_1d table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "econ_observations_1d" (
    "id" BIGSERIAL PRIMARY KEY,
    "category" "EconCategory" NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,
    CONSTRAINT "econ_obs_1d_cat_series_date_key" UNIQUE ("category", "seriesId", "eventDate"),
    CONSTRAINT "econ_observations_1d_seriesId_fkey" FOREIGN KEY ("seriesId")
        REFERENCES "economic_series"("seriesId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "econ_obs_1d_date_idx" ON "econ_observations_1d"("eventDate");
CREATE INDEX IF NOT EXISTS "econ_obs_1d_category_idx" ON "econ_observations_1d"("category");

-- ============================================================================
-- STEP 7: Migrate data from 8 econ tables to consolidated table
-- ============================================================================

-- Migrate econ_rates_1d → category: RATES
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'RATES'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_rates_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_yields_1d → category: MONEY
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'MONEY'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_yields_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_fx_1d → category: FX
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'FX'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_fx_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_vol_indices_1d → category: VOLATILITY
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'VOLATILITY'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_vol_indices_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_inflation_1d → category: INFLATION
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'INFLATION'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_inflation_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_labor_1d → category: LABOR
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'LABOR'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_labor_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_activity_1d → category: ACTIVITY
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'ACTIVITY'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_activity_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_money_1d → category: MONEY
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'MONEY'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_money_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- Migrate econ_commodities_1d → category: COMMODITIES
INSERT INTO "econ_observations_1d" ("category", "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
SELECT
    'COMMODITIES'::"EconCategory",
    "seriesId",
    "eventDate",
    "value"::DECIMAL(24,8),
    "source",
    "ingestedAt",
    "knowledgeTime",
    "rowHash",
    "metadata"
FROM "econ_commodities_1d"
ON CONFLICT ("category", "seriesId", "eventDate") DO NOTHING;

-- ============================================================================
-- STEP 8: Drop old econ tables and their indexes
-- ============================================================================

DROP TABLE IF EXISTS "econ_rates_1d" CASCADE;
DROP TABLE IF EXISTS "econ_yields_1d" CASCADE;
DROP TABLE IF EXISTS "econ_fx_1d" CASCADE;
DROP TABLE IF EXISTS "econ_vol_indices_1d" CASCADE;
DROP TABLE IF EXISTS "econ_inflation_1d" CASCADE;
DROP TABLE IF EXISTS "econ_labor_1d" CASCADE;
DROP TABLE IF EXISTS "econ_activity_1d" CASCADE;
DROP TABLE IF EXISTS "econ_money_1d" CASCADE;
DROP TABLE IF EXISTS "econ_commodities_1d" CASCADE;

-- ============================================================================
-- STEP 9: Update MktIndexes1d - rename symbol to symbolCode and convert to Decimal
-- ============================================================================

-- Rename column
ALTER TABLE "mkt_indexes_1d" RENAME COLUMN "symbol" TO "symbolCode";

-- Convert to Decimal
ALTER TABLE "mkt_indexes_1d" ALTER COLUMN "open" TYPE DECIMAL(18,6) USING "open"::DECIMAL(18,6);
ALTER TABLE "mkt_indexes_1d" ALTER COLUMN "high" TYPE DECIMAL(18,6) USING "high"::DECIMAL(18,6);
ALTER TABLE "mkt_indexes_1d" ALTER COLUMN "low" TYPE DECIMAL(18,6) USING "low"::DECIMAL(18,6);
ALTER TABLE "mkt_indexes_1d" ALTER COLUMN "close" TYPE DECIMAL(18,6) USING "close"::DECIMAL(18,6);

-- Drop redundant index
DROP INDEX IF EXISTS "mkt_indexes_1d_symbol_date_idx";

-- ============================================================================
-- STEP 10: Update MktSpot1d - rename symbol to symbolCode and convert to Decimal
-- ============================================================================

-- Rename column
ALTER TABLE "mkt_spot_1d" RENAME COLUMN "symbol" TO "symbolCode";

-- Convert to Decimal
ALTER TABLE "mkt_spot_1d" ALTER COLUMN "value" TYPE DECIMAL(18,6) USING "value"::DECIMAL(18,6);

-- Drop redundant index
DROP INDEX IF EXISTS "mkt_spot_1d_symbol_date_idx";

-- ============================================================================
-- STEP 11: Update PolicyNews1d - convert Float to Decimal
-- ============================================================================

ALTER TABLE "policy_news_1d" ALTER COLUMN "sentimentScore" TYPE DECIMAL(8,4) USING "sentimentScore"::DECIMAL(8,4);
ALTER TABLE "policy_news_1d" ALTER COLUMN "impactScore" TYPE DECIMAL(8,4) USING "impactScore"::DECIMAL(8,4);

-- ============================================================================
-- STEP 12: Update MacroReport1d - convert Float to Decimal
-- ============================================================================

ALTER TABLE "macro_reports_1d" ALTER COLUMN "actual" TYPE DECIMAL(24,8) USING "actual"::DECIMAL(24,8);
ALTER TABLE "macro_reports_1d" ALTER COLUMN "forecast" TYPE DECIMAL(24,8) USING "forecast"::DECIMAL(24,8);
ALTER TABLE "macro_reports_1d" ALTER COLUMN "previous" TYPE DECIMAL(24,8) USING "previous"::DECIMAL(24,8);
ALTER TABLE "macro_reports_1d" ALTER COLUMN "revised" TYPE DECIMAL(24,8) USING "revised"::DECIMAL(24,8);
ALTER TABLE "macro_reports_1d" ALTER COLUMN "surprise" TYPE DECIMAL(24,8) USING "surprise"::DECIMAL(24,8);
ALTER TABLE "macro_reports_1d" ALTER COLUMN "surprisePct" TYPE DECIMAL(10,4) USING "surprisePct"::DECIMAL(10,4);

-- ============================================================================
-- STEP 13: Update MeasuredMoveSignal - convert Float to Decimal and simplify dedupe key
-- ============================================================================

-- Convert to Decimal
ALTER TABLE "measured_move_signals" ALTER COLUMN "pointA" TYPE DECIMAL(18,6) USING "pointA"::DECIMAL(18,6);
ALTER TABLE "measured_move_signals" ALTER COLUMN "pointB" TYPE DECIMAL(18,6) USING "pointB"::DECIMAL(18,6);
ALTER TABLE "measured_move_signals" ALTER COLUMN "pointC" TYPE DECIMAL(18,6) USING "pointC"::DECIMAL(18,6);
ALTER TABLE "measured_move_signals" ALTER COLUMN "entry" TYPE DECIMAL(18,6) USING "entry"::DECIMAL(18,6);
ALTER TABLE "measured_move_signals" ALTER COLUMN "stop" TYPE DECIMAL(18,6) USING "stop"::DECIMAL(18,6);
ALTER TABLE "measured_move_signals" ALTER COLUMN "target100" TYPE DECIMAL(18,6) USING "target100"::DECIMAL(18,6);
ALTER TABLE "measured_move_signals" ALTER COLUMN "target1236" TYPE DECIMAL(18,6) USING "target1236"::DECIMAL(18,6);
ALTER TABLE "measured_move_signals" ALTER COLUMN "retracementRatio" TYPE DECIMAL(8,6) USING "retracementRatio"::DECIMAL(8,6);

-- Drop old unique constraint and create new simplified one
DROP INDEX IF EXISTS "mm_signals_dedupe_key";
ALTER TABLE "measured_move_signals" DROP CONSTRAINT IF EXISTS "mm_signals_dedupe_key";
ALTER TABLE "measured_move_signals" DROP CONSTRAINT IF EXISTS "measured_move_signals_symbolCode_timeframe_timestamp_direction_key";
DO $$ BEGIN
    ALTER TABLE "measured_move_signals" ADD CONSTRAINT "mm_signals_dedupe_key"
        UNIQUE ("symbolCode", "timeframe", "timestamp", "direction");
EXCEPTION
    WHEN duplicate_object THEN null;
    WHEN duplicate_table THEN null;
END $$;

-- ============================================================================
-- STEP 14: Update BhgSetup - convert to enums and Decimal
-- ============================================================================

-- Convert string columns to enums (map existing lowercase/shorthand values)
UPDATE "bhg_setups" SET "direction" = CASE
    WHEN UPPER("direction") = 'BULLISH' THEN 'BULLISH'
    WHEN UPPER("direction") = 'BEARISH' THEN 'BEARISH'
    ELSE "direction" END;

UPDATE "bhg_setups" SET "timeframe" = CASE
    WHEN "timeframe" IN ('1m', '1M')   THEN 'M1'
    WHEN "timeframe" IN ('5m', '5M')   THEN 'M5'
    WHEN "timeframe" IN ('15m', '15M') THEN 'M15'
    WHEN "timeframe" IN ('1h', '1H')   THEN 'H1'
    WHEN "timeframe" IN ('4h', '4H')   THEN 'H4'
    WHEN "timeframe" IN ('1d', '1D')   THEN 'D1'
    ELSE "timeframe" END;

UPDATE "bhg_setups" SET "phase" = CASE
    WHEN UPPER("phase") = 'TOUCHED'  THEN 'TOUCHED'
    WHEN UPPER("phase") = 'HOOKED'   THEN 'HOOKED'
    WHEN UPPER("phase") = 'GO_FIRED' THEN 'GO_FIRED'
    WHEN UPPER("phase") = 'EXPIRED'  THEN 'EXPIRED'
    WHEN UPPER("phase") = 'STOPPED'  THEN 'STOPPED'
    WHEN UPPER("phase") = 'TP1_HIT'  THEN 'TP1_HIT'
    WHEN UPPER("phase") = 'TP2_HIT'  THEN 'TP2_HIT'
    ELSE "phase" END;

ALTER TABLE "bhg_setups" ALTER COLUMN "direction" TYPE "SignalDirection" USING "direction"::"SignalDirection";
ALTER TABLE "bhg_setups" ALTER COLUMN "timeframe" TYPE "Timeframe" USING "timeframe"::"Timeframe";
ALTER TABLE "bhg_setups" ALTER COLUMN "phase" TYPE "BhgPhase" USING "phase"::"BhgPhase";

-- Convert Float to Decimal
ALTER TABLE "bhg_setups" ALTER COLUMN "fibLevel" TYPE DECIMAL(18,6) USING "fibLevel"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "fibRatio" TYPE DECIMAL(8,6) USING "fibRatio"::DECIMAL(8,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "hookLow" TYPE DECIMAL(18,6) USING "hookLow"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "hookHigh" TYPE DECIMAL(18,6) USING "hookHigh"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "hookClose" TYPE DECIMAL(18,6) USING "hookClose"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "entry" TYPE DECIMAL(18,6) USING "entry"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "stopLoss" TYPE DECIMAL(18,6) USING "stopLoss"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "tp1" TYPE DECIMAL(18,6) USING "tp1"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "tp2" TYPE DECIMAL(18,6) USING "tp2"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "maxFavorable" TYPE DECIMAL(18,6) USING "maxFavorable"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "maxAdverse" TYPE DECIMAL(18,6) USING "maxAdverse"::DECIMAL(18,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "pTp1" TYPE DECIMAL(8,6) USING "pTp1"::DECIMAL(8,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "pTp2" TYPE DECIMAL(8,6) USING "pTp2"::DECIMAL(8,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "correlationScore" TYPE DECIMAL(8,6) USING "correlationScore"::DECIMAL(8,6);
ALTER TABLE "bhg_setups" ALTER COLUMN "vixLevel" TYPE DECIMAL(10,4) USING "vixLevel"::DECIMAL(10,4);

-- ============================================================================
-- STEP 15: Update IngestionRun - convert status to enum
-- ============================================================================

-- Convert string to enum (handle existing values)
UPDATE "ingestion_runs" SET "status" = 'COMPLETED' WHERE "status" IN ('SUCCEEDED', 'SUCCESS');
UPDATE "ingestion_runs" SET "status" = 'FAILED' WHERE "status" IN ('PARTIAL', 'ERROR');

-- Drop existing default before type change
ALTER TABLE "ingestion_runs" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "ingestion_runs" ALTER COLUMN "status" TYPE "IngestionStatus"
    USING CASE
        WHEN "status" = 'RUNNING' THEN 'RUNNING'::"IngestionStatus"
        WHEN "status" = 'COMPLETED' THEN 'COMPLETED'::"IngestionStatus"
        ELSE 'FAILED'::"IngestionStatus"
    END;
ALTER TABLE "ingestion_runs" ALTER COLUMN "status" SET DEFAULT 'RUNNING'::"IngestionStatus";

-- ============================================================================
-- STEP 16: Update MesModelRegistry - add updatedAt and convert Float to Decimal
-- ============================================================================

-- Add updatedAt column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'mes_model_registry' AND column_name = 'updatedAt'
    ) THEN
        ALTER TABLE "mes_model_registry" ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$;

-- Convert Float to Decimal
ALTER TABLE "mes_model_registry" ALTER COLUMN "oofBrier" TYPE DECIMAL(10,8) USING "oofBrier"::DECIMAL(10,8);
ALTER TABLE "mes_model_registry" ALTER COLUMN "oofLogLoss" TYPE DECIMAL(10,8) USING "oofLogLoss"::DECIMAL(10,8);
ALTER TABLE "mes_model_registry" ALTER COLUMN "oofAuc" TYPE DECIMAL(10,8) USING "oofAuc"::DECIMAL(10,8);

-- ============================================================================
-- Migration complete
-- ============================================================================
