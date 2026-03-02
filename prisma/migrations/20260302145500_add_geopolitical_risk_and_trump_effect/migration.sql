-- CreateTable
CREATE TABLE "geopolitical_risk_1d" (
    "id" BIGSERIAL NOT NULL,
    "eventDate" DATE NOT NULL,
    "indexName" VARCHAR(32) NOT NULL,
    "value" DECIMAL(14,6) NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "sourceUrl" TEXT,
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "geopolitical_risk_1d_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trump_effect_1d" (
    "id" BIGSERIAL NOT NULL,
    "eventDate" DATE NOT NULL,
    "eventType" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "marketImpact" VARCHAR(16),
    "sector" VARCHAR(64),
    "source" VARCHAR(64) NOT NULL,
    "sourceId" VARCHAR(128),
    "sourceUrl" TEXT,
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "trump_effect_1d_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "geopolitical_risk_1d_row_hash_key" ON "geopolitical_risk_1d"("rowHash");
CREATE UNIQUE INDEX "geopolitical_risk_1d_date_index_source_key" ON "geopolitical_risk_1d"("eventDate", "indexName", "source");
CREATE INDEX "geopolitical_risk_1d_date_idx" ON "geopolitical_risk_1d"("eventDate");
CREATE INDEX "geopolitical_risk_1d_index_name_idx" ON "geopolitical_risk_1d"("indexName");
CREATE INDEX "geopolitical_risk_1d_source_idx" ON "geopolitical_risk_1d"("source");

CREATE UNIQUE INDEX "trump_effect_1d_row_hash_key" ON "trump_effect_1d"("rowHash");
CREATE UNIQUE INDEX "trump_effect_1d_date_type_title_source_key" ON "trump_effect_1d"("eventDate", "eventType", "title", "source");
CREATE INDEX "trump_effect_1d_date_idx" ON "trump_effect_1d"("eventDate");
CREATE INDEX "trump_effect_1d_event_type_idx" ON "trump_effect_1d"("eventType");
CREATE INDEX "trump_effect_1d_market_impact_idx" ON "trump_effect_1d"("marketImpact");
CREATE INDEX "trump_effect_1d_source_idx" ON "trump_effect_1d"("source");
