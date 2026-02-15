-- Retire consolidated econ_observations_1d.
-- Move any remaining rows into domain-specific econ_*_1d tables, then drop.
DO $$
BEGIN
  IF to_regclass('public.econ_observations_1d') IS NULL THEN
    RAISE NOTICE 'econ_observations_1d does not exist; skipping.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "econ_observations_1d"
    WHERE "category"::text NOT IN (
      'RATES',
      'YIELDS',
      'FX',
      'VOLATILITY',
      'INFLATION',
      'LABOR',
      'ACTIVITY',
      'MONEY',
      'COMMODITIES'
    )
  ) THEN
    RAISE EXCEPTION 'Unsupported categories found in econ_observations_1d. Aborting drop.';
  END IF;

  INSERT INTO "econ_rates_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'RATES'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_yields_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'YIELDS'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_fx_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'FX'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_vol_indices_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'VOLATILITY'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_inflation_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'INFLATION'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_labor_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'LABOR'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_activity_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'ACTIVITY'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_money_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'MONEY'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  INSERT INTO "econ_commodities_1d" ("seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata")
  SELECT "seriesId", "eventDate", "value", "source", "ingestedAt", "knowledgeTime", "rowHash", "metadata"
  FROM "econ_observations_1d"
  WHERE "category" = 'COMMODITIES'
  ON CONFLICT ("seriesId", "eventDate") DO NOTHING;

  DROP TABLE "econ_observations_1d";
END $$;
