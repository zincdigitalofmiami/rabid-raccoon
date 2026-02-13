-- Add YIELDS to EconCategory enum
ALTER TYPE "EconCategory" ADD VALUE IF NOT EXISTS 'YIELDS';

-- Reclassify yield series from MONEY to YIELDS
-- Common yield series from FRED: DGS10, DGS2, DGS5, DGS30, DGS1, DGS3MO, T10Y2Y, T10Y3M, T10YIE, T5YIE
UPDATE "econ_observations_1d"
SET "category" = 'YIELDS'
WHERE "category" = 'MONEY'
  AND "seriesId" IN ('DGS10', 'DGS2', 'DGS5', 'DGS30', 'DGS1', 'DGS3MO', 'T10Y2Y', 'T10Y3M', 'T10YIE', 'T5YIE', 'DFII10', 'DFII5');
