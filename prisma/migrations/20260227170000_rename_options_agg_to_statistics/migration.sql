-- Rename options statistics table from generic agg naming to explicit statistics naming.
ALTER TABLE "mkt_options_agg_1d" RENAME TO "mkt_options_statistics_1d";

ALTER TABLE "mkt_options_statistics_1d"
  RENAME CONSTRAINT "mkt_options_agg_1d_pkey" TO "mkt_options_statistics_1d_pkey";

ALTER INDEX "mkt_options_agg_1d_parent_date_key"
  RENAME TO "mkt_options_statistics_1d_parent_date_key";

ALTER INDEX "mkt_options_agg_1d_date_idx"
  RENAME TO "mkt_options_statistics_1d_date_idx";

ALTER INDEX "mkt_options_agg_1d_parent_idx"
  RENAME TO "mkt_options_statistics_1d_parent_idx";

ALTER SEQUENCE IF EXISTS "mkt_options_agg_1d_id_seq"
  RENAME TO "mkt_options_statistics_1d_id_seq";
