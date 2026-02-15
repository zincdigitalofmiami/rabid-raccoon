-- Add dedicated MES daily table.
CREATE TABLE IF NOT EXISTS "mkt_futures_mes_1d" (
  "id" BIGSERIAL NOT NULL,
  "eventDate" DATE NOT NULL,
  "open" DECIMAL(18,6) NOT NULL,
  "high" DECIMAL(18,6) NOT NULL,
  "low" DECIMAL(18,6) NOT NULL,
  "close" DECIMAL(18,6) NOT NULL,
  "volume" BIGINT,
  "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
  "sourceDataset" VARCHAR(64),
  "sourceSchema" VARCHAR(32),
  "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rowHash" VARCHAR(64),
  "metadata" JSONB,
  CONSTRAINT "mkt_futures_mes_1d_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mkt_futures_mes_1d_event_date_key"
ON "mkt_futures_mes_1d"("eventDate");

CREATE INDEX IF NOT EXISTS "mkt_futures_mes_1d_date_idx"
ON "mkt_futures_mes_1d"("eventDate");

-- Seed from existing 1h MES data.
INSERT INTO "mkt_futures_mes_1d" (
  "eventDate",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "source",
  "sourceDataset",
  "sourceSchema",
  "metadata"
)
SELECT
  (date_trunc('day', "eventTime" AT TIME ZONE 'UTC'))::date AS "eventDate",
  (array_agg("open" ORDER BY "eventTime" ASC))[1] AS "open",
  MAX("high") AS "high",
  MIN("low") AS "low",
  (array_agg("close" ORDER BY "eventTime" DESC))[1] AS "close",
  COALESCE(SUM("volume"), 0)::BIGINT AS "volume",
  'DATABENTO'::"DataSource" AS "source",
  'GLBX.MDP3' AS "sourceDataset",
  'ohlcv-1h->1d' AS "sourceSchema",
  jsonb_build_object('derivedFrom', 'mkt_futures_mes_1h') AS "metadata"
FROM "mkt_futures_mes_1h"
GROUP BY 1
ON CONFLICT ("eventDate") DO NOTHING;
