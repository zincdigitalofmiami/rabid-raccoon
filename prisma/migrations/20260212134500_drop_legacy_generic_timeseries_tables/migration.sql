-- Drop legacy generic time-series tables to enforce explicit domain models only.
DROP TABLE IF EXISTS "economic_observations_1d";
DROP TABLE IF EXISTS "macro_indicators";
