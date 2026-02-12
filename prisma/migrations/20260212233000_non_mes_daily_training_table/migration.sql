-- Non-MES futures move to daily-only training storage.
CREATE TABLE "futures_ex_mes_1d" (
    "id" BIGSERIAL NOT NULL,
    "symbolCode" VARCHAR(16) NOT NULL,
    "eventDate" DATE NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT,
    "openInterest" BIGINT,
    "source" "DataSource" NOT NULL DEFAULT 'DATABENTO',
    "sourceDataset" VARCHAR(64),
    "sourceSchema" VARCHAR(32),
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "knowledgeTime" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rowHash" VARCHAR(64),
    "metadata" JSONB,
    CONSTRAINT "futures_ex_mes_1d_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "futures_ex_mes_1d_symbol_date_key" ON "futures_ex_mes_1d"("symbolCode", "eventDate");
CREATE INDEX "futures_ex_mes_1d_symbol_date_idx" ON "futures_ex_mes_1d"("symbolCode", "eventDate");
CREATE INDEX "futures_ex_mes_1d_date_idx" ON "futures_ex_mes_1d"("eventDate");

ALTER TABLE "futures_ex_mes_1d"
ADD CONSTRAINT "futures_ex_mes_1d_symbolCode_fkey"
FOREIGN KEY ("symbolCode") REFERENCES "symbols"("code") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "futures_ex_mes_1d"
ADD CONSTRAINT "futures_ex_mes_1d_symbol_not_mes_chk"
CHECK ("symbolCode" <> 'MES');

-- Kill legacy non-MES 1h payload now that non-MES is daily-only.
DELETE FROM "futures_ex_mes_1h";
