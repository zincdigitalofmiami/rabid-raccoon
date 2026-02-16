-- Create econ_indexes_1d for market index data (SP500, NASDAQCOM, etc.)
CREATE TABLE "econ_indexes_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DECIMAL(24,8),
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_indexes_1d_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one value per series per date
ALTER TABLE "econ_indexes_1d" ADD CONSTRAINT "econ_indexes_1d_series_date_key" UNIQUE ("seriesId", "eventDate");

-- Index on date for range queries
CREATE INDEX "econ_indexes_1d_date_idx" ON "econ_indexes_1d"("eventDate");

-- Foreign key to economic_series
ALTER TABLE "econ_indexes_1d" ADD CONSTRAINT "econ_indexes_1d_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "economic_series"("seriesId") ON DELETE RESTRICT ON UPDATE CASCADE;
