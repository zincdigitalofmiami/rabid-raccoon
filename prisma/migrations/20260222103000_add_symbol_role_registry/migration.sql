-- Symbol registry role tables + initial role seeding from current approved lists.

CREATE TABLE "symbol_roles" (
  "role_key" VARCHAR(64) NOT NULL,
  "description" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "symbol_roles_pkey" PRIMARY KEY ("role_key")
);

CREATE INDEX "symbol_roles_is_active_idx"
  ON "symbol_roles" ("is_active");

CREATE TABLE "symbol_role_members" (
  "id" BIGSERIAL NOT NULL,
  "role_key" VARCHAR(64) NOT NULL,
  "symbol_code" VARCHAR(16) NOT NULL,
  "position" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "symbol_role_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "symbol_role_members_role_key_fkey"
    FOREIGN KEY ("role_key") REFERENCES "symbol_roles" ("role_key")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "symbol_role_members_symbol_code_fkey"
    FOREIGN KEY ("symbol_code") REFERENCES "symbols" ("code")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "symbol_role_members_position_chk" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "symbol_role_members_role_symbol_key"
  ON "symbol_role_members" ("role_key", "symbol_code");

CREATE UNIQUE INDEX "symbol_role_members_role_position_key"
  ON "symbol_role_members" ("role_key", "position");

CREATE INDEX "symbol_role_members_symbol_code_idx"
  ON "symbol_role_members" ("symbol_code");

CREATE INDEX "symbol_role_members_role_enabled_idx"
  ON "symbol_role_members" ("role_key", "enabled");

INSERT INTO "symbol_roles" ("role_key", "description")
VALUES
  ('INGESTION_ACTIVE', 'Canonical active ingestion universe'),
  ('INGESTION_NON_MES_ACTIVE', 'Canonical non-MES ingestion universe'),
  ('INNGEST_EQUITY_INDICES', 'Scheduled Inngest equity index futures'),
  ('INNGEST_TREASURIES', 'Scheduled Inngest treasury futures'),
  ('INNGEST_COMMODITIES', 'Scheduled Inngest commodities futures'),
  ('INNGEST_FX_RATES', 'Scheduled Inngest FX/rates futures'),
  ('INNGEST_MES_ONLY', 'Scheduled Inngest MES-only ingestion'),
  ('MEASURED_MOVE_DEFAULT', 'Default measured move symbol set'),
  ('CORRELATION_SET', 'MES intraday correlation universe'),
  ('FORECAST_UNIVERSE', 'Forecast route symbol universe'),
  ('ANALYSIS_DEFAULT', 'Default analysis symbol universe'),
  ('TRAINING_CROSS_ASSET', 'Cross-asset features for lean dataset build'),
  ('DASHBOARD_MARKETS_INDICES', 'MarketsGrid indices group'),
  ('DASHBOARD_MARKETS_COMMODITIES', 'MarketsGrid commodities group'),
  ('DASHBOARD_MARKETS_MACRO', 'MarketsGrid macro group'),
  ('DB_ALIGNMENT_EXPECTED', 'Expected symbols for DB alignment checks')
ON CONFLICT ("role_key") DO UPDATE
SET
  "description" = EXCLUDED."description",
  "updated_at" = NOW();

CREATE TEMP TABLE "_symbol_role_seed" (
  "role_key" VARCHAR(64) NOT NULL,
  "symbol_code" VARCHAR(16) NOT NULL,
  "position" INTEGER NOT NULL
) ON COMMIT DROP;

INSERT INTO "_symbol_role_seed" ("role_key", "symbol_code", "position")
VALUES
  ('INGESTION_ACTIVE', 'ES', 0),
  ('INGESTION_ACTIVE', 'MES', 1),
  ('INGESTION_ACTIVE', 'NQ', 2),
  ('INGESTION_ACTIVE', 'YM', 3),
  ('INGESTION_ACTIVE', 'RTY', 4),
  ('INGESTION_ACTIVE', 'SOX', 5),
  ('INGESTION_ACTIVE', 'ZN', 6),
  ('INGESTION_ACTIVE', 'ZB', 7),
  ('INGESTION_ACTIVE', 'ZF', 8),
  ('INGESTION_ACTIVE', 'CL', 9),
  ('INGESTION_ACTIVE', 'GC', 10),
  ('INGESTION_ACTIVE', 'SI', 11),
  ('INGESTION_ACTIVE', 'NG', 12),
  ('INGESTION_ACTIVE', '6E', 13),
  ('INGESTION_ACTIVE', '6J', 14),
  ('INGESTION_ACTIVE', 'SR3', 15),

  ('INGESTION_NON_MES_ACTIVE', 'ES', 0),
  ('INGESTION_NON_MES_ACTIVE', 'NQ', 1),
  ('INGESTION_NON_MES_ACTIVE', 'YM', 2),
  ('INGESTION_NON_MES_ACTIVE', 'RTY', 3),
  ('INGESTION_NON_MES_ACTIVE', 'SOX', 4),
  ('INGESTION_NON_MES_ACTIVE', 'ZN', 5),
  ('INGESTION_NON_MES_ACTIVE', 'ZB', 6),
  ('INGESTION_NON_MES_ACTIVE', 'ZF', 7),
  ('INGESTION_NON_MES_ACTIVE', 'CL', 8),
  ('INGESTION_NON_MES_ACTIVE', 'GC', 9),
  ('INGESTION_NON_MES_ACTIVE', 'SI', 10),

  ('INNGEST_EQUITY_INDICES', 'ES', 0),
  ('INNGEST_EQUITY_INDICES', 'NQ', 1),
  ('INNGEST_EQUITY_INDICES', 'YM', 2),
  ('INNGEST_EQUITY_INDICES', 'RTY', 3),
  ('INNGEST_EQUITY_INDICES', 'SOX', 4),

  ('INNGEST_TREASURIES', 'ZN', 0),
  ('INNGEST_TREASURIES', 'ZB', 1),
  ('INNGEST_TREASURIES', 'ZF', 2),

  ('INNGEST_COMMODITIES', 'CL', 0),
  ('INNGEST_COMMODITIES', 'GC', 1),
  ('INNGEST_COMMODITIES', 'SI', 2),
  ('INNGEST_COMMODITIES', 'NG', 3),

  ('INNGEST_FX_RATES', '6E', 0),
  ('INNGEST_FX_RATES', '6J', 1),
  ('INNGEST_FX_RATES', 'SR3', 2),

  ('INNGEST_MES_ONLY', 'MES', 0),
  ('MEASURED_MOVE_DEFAULT', 'MES', 0),

  ('CORRELATION_SET', 'MES', 0),
  ('CORRELATION_SET', 'NQ', 1),
  ('CORRELATION_SET', 'VX', 2),
  ('CORRELATION_SET', 'DX', 3),

  ('FORECAST_UNIVERSE', 'MES', 0),
  ('FORECAST_UNIVERSE', 'NQ', 1),
  ('FORECAST_UNIVERSE', 'YM', 2),
  ('FORECAST_UNIVERSE', 'RTY', 3),
  ('FORECAST_UNIVERSE', 'VX', 4),
  ('FORECAST_UNIVERSE', 'US10Y', 5),
  ('FORECAST_UNIVERSE', 'ZN', 6),
  ('FORECAST_UNIVERSE', 'ZB', 7),
  ('FORECAST_UNIVERSE', 'DX', 8),
  ('FORECAST_UNIVERSE', 'GC', 9),
  ('FORECAST_UNIVERSE', 'CL', 10),

  ('ANALYSIS_DEFAULT', 'MES', 0),
  ('ANALYSIS_DEFAULT', 'NQ', 1),
  ('ANALYSIS_DEFAULT', 'YM', 2),
  ('ANALYSIS_DEFAULT', 'RTY', 3),
  ('ANALYSIS_DEFAULT', 'VX', 4),
  ('ANALYSIS_DEFAULT', 'US10Y', 5),
  ('ANALYSIS_DEFAULT', 'ZN', 6),
  ('ANALYSIS_DEFAULT', 'DX', 7),
  ('ANALYSIS_DEFAULT', 'GC', 8),
  ('ANALYSIS_DEFAULT', 'CL', 9),

  ('TRAINING_CROSS_ASSET', 'NQ', 0),
  ('TRAINING_CROSS_ASSET', 'ZN', 1),
  ('TRAINING_CROSS_ASSET', 'CL', 2),
  ('TRAINING_CROSS_ASSET', '6E', 3),
  ('TRAINING_CROSS_ASSET', '6J', 4),
  ('TRAINING_CROSS_ASSET', 'NG', 5),

  ('DASHBOARD_MARKETS_INDICES', 'MES', 0),
  ('DASHBOARD_MARKETS_INDICES', 'NQ', 1),
  ('DASHBOARD_MARKETS_INDICES', 'YM', 2),
  ('DASHBOARD_MARKETS_INDICES', 'RTY', 3),

  ('DASHBOARD_MARKETS_COMMODITIES', 'GC', 0),
  ('DASHBOARD_MARKETS_COMMODITIES', 'CL', 1),

  ('DASHBOARD_MARKETS_MACRO', 'VX', 0),
  ('DASHBOARD_MARKETS_MACRO', 'US10Y', 1),
  ('DASHBOARD_MARKETS_MACRO', 'ZN', 2),
  ('DASHBOARD_MARKETS_MACRO', 'ZB', 3),
  ('DASHBOARD_MARKETS_MACRO', 'DX', 4),

  ('DB_ALIGNMENT_EXPECTED', 'NQ', 0),
  ('DB_ALIGNMENT_EXPECTED', 'ZN', 1),
  ('DB_ALIGNMENT_EXPECTED', 'CL', 2),
  ('DB_ALIGNMENT_EXPECTED', '6E', 3),
  ('DB_ALIGNMENT_EXPECTED', '6J', 4),
  ('DB_ALIGNMENT_EXPECTED', 'NG', 5);

DO $$
DECLARE missing_codes TEXT;
BEGIN
  SELECT string_agg(x.symbol_code, ', ' ORDER BY x.symbol_code)
  INTO missing_codes
  FROM (
    SELECT DISTINCT s."symbol_code"
    FROM "_symbol_role_seed" s
    LEFT JOIN "symbols" sym ON sym."code" = s."symbol_code"
    WHERE sym."code" IS NULL
  ) x;

  IF missing_codes IS NOT NULL THEN
    RAISE EXCEPTION 'symbol role seed references unknown symbols: %', missing_codes;
  END IF;
END $$;

INSERT INTO "symbol_role_members" (
  "role_key",
  "symbol_code",
  "position",
  "enabled",
  "created_at",
  "updated_at"
)
SELECT
  s."role_key",
  s."symbol_code",
  s."position",
  true,
  NOW(),
  NOW()
FROM "_symbol_role_seed" s
ON CONFLICT ("role_key", "symbol_code") DO UPDATE
SET
  "position" = EXCLUDED."position",
  "enabled" = true,
  "updated_at" = NOW();
