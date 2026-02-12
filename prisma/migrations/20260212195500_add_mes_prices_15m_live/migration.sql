CREATE TABLE "mes_prices_15m" (
    "id" BIGSERIAL NOT NULL,
    "eventTime" TIMESTAMPTZ(6) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,

    CONSTRAINT "mes_prices_15m_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mes_prices_15m_event_time_key" ON "mes_prices_15m"("eventTime");
CREATE INDEX "mes_prices_15m_event_time_idx" ON "mes_prices_15m"("eventTime");
