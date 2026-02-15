-- Add economic calendar and lightweight news signal tables.

CREATE TABLE IF NOT EXISTS "econ_calendar" (
  "id" BIGSERIAL NOT NULL,
  "eventDate" DATE NOT NULL,
  "eventTime" VARCHAR(16),
  "eventName" VARCHAR(120) NOT NULL,
  "eventType" VARCHAR(64) NOT NULL,
  "fredReleaseId" INTEGER,
  "fredSeriesId" VARCHAR(50),
  "frequency" VARCHAR(32),
  "forecast" DECIMAL(24,8),
  "previous" DECIMAL(24,8),
  "actual" DECIMAL(24,8),
  "surprise" DECIMAL(24,8),
  "impactRating" VARCHAR(16),
  "source" VARCHAR(64),
  "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "econ_calendar_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "econ_calendar_date_name_key"
ON "econ_calendar" ("eventDate", "eventName");

CREATE INDEX IF NOT EXISTS "econ_calendar_date_idx"
ON "econ_calendar" ("eventDate");

CREATE INDEX IF NOT EXISTS "econ_calendar_type_idx"
ON "econ_calendar" ("eventType");

CREATE INDEX IF NOT EXISTS "econ_calendar_series_idx"
ON "econ_calendar" ("fredSeriesId");

CREATE TABLE IF NOT EXISTS "news_signals" (
  "id" BIGSERIAL NOT NULL,
  "title" TEXT NOT NULL,
  "link" TEXT NOT NULL,
  "pubDate" TIMESTAMPTZ(6) NOT NULL,
  "source" VARCHAR(100),
  "query" VARCHAR(200) NOT NULL,
  "layer" VARCHAR(64) NOT NULL,
  "category" VARCHAR(64) NOT NULL,
  "sentimentScore" DECIMAL(8,4),
  "relevanceScore" DECIMAL(8,4),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "news_signals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "news_signals_link_key"
ON "news_signals" ("link");

CREATE INDEX IF NOT EXISTS "news_signals_pub_date_idx"
ON "news_signals" ("pubDate");

CREATE INDEX IF NOT EXISTS "news_signals_layer_idx"
ON "news_signals" ("layer");

CREATE INDEX IF NOT EXISTS "news_signals_category_idx"
ON "news_signals" ("category");

CREATE INDEX IF NOT EXISTS "news_signals_layer_pub_date_idx"
ON "news_signals" ("layer", "pubDate");
