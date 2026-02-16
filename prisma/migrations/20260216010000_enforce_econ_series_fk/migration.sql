-- Ensure all series used by split econ tables exist in economic_series,
-- then enforce FK constraints to prevent future drift.

WITH split_series AS (
  SELECT DISTINCT "seriesId", 'RATES'::"EconCategory" AS category, 1 AS priority FROM "econ_rates_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'YIELDS'::"EconCategory" AS category, 2 AS priority FROM "econ_yields_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'FX'::"EconCategory" AS category, 3 AS priority FROM "econ_fx_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'VOLATILITY'::"EconCategory" AS category, 4 AS priority FROM "econ_vol_indices_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'INFLATION'::"EconCategory" AS category, 5 AS priority FROM "econ_inflation_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'LABOR'::"EconCategory" AS category, 6 AS priority FROM "econ_labor_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'ACTIVITY'::"EconCategory" AS category, 7 AS priority FROM "econ_activity_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'MONEY'::"EconCategory" AS category, 8 AS priority FROM "econ_money_1d"
  UNION ALL
  SELECT DISTINCT "seriesId", 'COMMODITIES'::"EconCategory" AS category, 9 AS priority FROM "econ_commodities_1d"
), canonical AS (
  SELECT DISTINCT ON ("seriesId") "seriesId", category
  FROM split_series
  ORDER BY "seriesId", priority
)
INSERT INTO "economic_series" (
  "seriesId",
  "displayName",
  "category",
  "source",
  "sourceSymbol",
  "isActive",
  "metadata",
  "createdAt",
  "updatedAt"
)
SELECT
  c."seriesId",
  c."seriesId",
  c.category,
  'FRED'::"DataSource",
  c."seriesId",
  true,
  jsonb_build_object('reconciled', true, 'reconciledBy', '20260216010000_enforce_econ_series_fk'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM canonical c
LEFT JOIN "economic_series" es ON es."seriesId" = c."seriesId"
WHERE es."seriesId" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_rates_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_rates_1d"
      ADD CONSTRAINT "econ_rates_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_yields_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_yields_1d"
      ADD CONSTRAINT "econ_yields_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_fx_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_fx_1d"
      ADD CONSTRAINT "econ_fx_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_vol_indices_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_vol_indices_1d"
      ADD CONSTRAINT "econ_vol_indices_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_inflation_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_inflation_1d"
      ADD CONSTRAINT "econ_inflation_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_labor_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_labor_1d"
      ADD CONSTRAINT "econ_labor_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_activity_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_activity_1d"
      ADD CONSTRAINT "econ_activity_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_money_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_money_1d"
      ADD CONSTRAINT "econ_money_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'econ_commodities_1d_seriesId_fkey') THEN
    ALTER TABLE "econ_commodities_1d"
      ADD CONSTRAINT "econ_commodities_1d_seriesId_fkey"
      FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
