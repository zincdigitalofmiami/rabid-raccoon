CREATE TABLE "econ_inflation_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_inflation_1d_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "econ_labor_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_labor_1d_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "econ_activity_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_activity_1d_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "econ_money_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_money_1d_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "econ_commodities_1d" (
    "id" BIGSERIAL NOT NULL,
    "seriesId" VARCHAR(50) NOT NULL,
    "eventDate" DATE NOT NULL,
    "value" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'FRED',
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "econ_commodities_1d_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "econ_news_1d" (
    "id" BIGSERIAL NOT NULL,
    "articleId" VARCHAR(128),
    "eventDate" DATE NOT NULL,
    "publishedAt" TIMESTAMPTZ(6),
    "headline" TEXT NOT NULL,
    "summary" TEXT,
    "content" TEXT,
    "source" VARCHAR(100),
    "author" VARCHAR(100),
    "url" TEXT,
    "sentimentLabel" VARCHAR(32),
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "rawPayload" JSONB,

    CONSTRAINT "econ_news_1d_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "econ_inflation_1d_series_date_key" ON "econ_inflation_1d"("seriesId", "eventDate");
CREATE INDEX "econ_inflation_1d_series_date_idx" ON "econ_inflation_1d"("seriesId", "eventDate");
CREATE INDEX "econ_inflation_1d_date_idx" ON "econ_inflation_1d"("eventDate");

CREATE UNIQUE INDEX "econ_labor_1d_series_date_key" ON "econ_labor_1d"("seriesId", "eventDate");
CREATE INDEX "econ_labor_1d_series_date_idx" ON "econ_labor_1d"("seriesId", "eventDate");
CREATE INDEX "econ_labor_1d_date_idx" ON "econ_labor_1d"("eventDate");

CREATE UNIQUE INDEX "econ_activity_1d_series_date_key" ON "econ_activity_1d"("seriesId", "eventDate");
CREATE INDEX "econ_activity_1d_series_date_idx" ON "econ_activity_1d"("seriesId", "eventDate");
CREATE INDEX "econ_activity_1d_date_idx" ON "econ_activity_1d"("eventDate");

CREATE UNIQUE INDEX "econ_money_1d_series_date_key" ON "econ_money_1d"("seriesId", "eventDate");
CREATE INDEX "econ_money_1d_series_date_idx" ON "econ_money_1d"("seriesId", "eventDate");
CREATE INDEX "econ_money_1d_date_idx" ON "econ_money_1d"("eventDate");

CREATE UNIQUE INDEX "econ_commodities_1d_series_date_key" ON "econ_commodities_1d"("seriesId", "eventDate");
CREATE INDEX "econ_commodities_1d_series_date_idx" ON "econ_commodities_1d"("seriesId", "eventDate");
CREATE INDEX "econ_commodities_1d_date_idx" ON "econ_commodities_1d"("eventDate");

CREATE UNIQUE INDEX "econ_news_1d_row_hash_key" ON "econ_news_1d"("rowHash");
CREATE INDEX "econ_news_1d_date_idx" ON "econ_news_1d"("eventDate");
CREATE INDEX "econ_news_1d_source_idx" ON "econ_news_1d"("source");
CREATE INDEX "econ_news_1d_tags_idx" ON "econ_news_1d"("tags");

CREATE UNIQUE INDEX "policy_news_1d_row_hash_key" ON "policy_news_1d"("rowHash");
