-- Rename mkt_options_agg_1d → mkt_options_statistics_1d
-- Aligns Prisma schema with the actual DB table name.
-- The table was manually renamed outside Prisma before this migration was created.
-- This migration exists so fresh deploys (prisma migrate deploy) reach the correct state.

ALTER TABLE IF EXISTS "mkt_options_agg_1d" RENAME TO "mkt_options_statistics_1d";

-- Rename indexes to match
ALTER INDEX IF EXISTS "mkt_options_agg_1d_pkey" RENAME TO "mkt_options_statistics_1d_pkey";
ALTER INDEX IF EXISTS "mkt_options_agg_1d_parent_date_key" RENAME TO "mkt_options_statistics_1d_parent_date_key";
ALTER INDEX IF EXISTS "mkt_options_agg_1d_date_idx" RENAME TO "mkt_options_statistics_1d_date_idx";
ALTER INDEX IF EXISTS "mkt_options_agg_1d_parent_idx" RENAME TO "mkt_options_statistics_1d_parent_idx";

-- Rename the sequence backing the id column
ALTER SEQUENCE IF EXISTS "mkt_options_agg_1d_id_seq" RENAME TO "mkt_options_statistics_1d_id_seq";
