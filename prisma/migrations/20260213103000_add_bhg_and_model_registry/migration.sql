-- Create missing BHG setup persistence table.
CREATE TABLE IF NOT EXISTS "bhg_setups" (
    "id" BIGSERIAL NOT NULL,
    "setupId" VARCHAR(128) NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "timeframe" VARCHAR(10) NOT NULL,
    "phase" VARCHAR(20) NOT NULL,
    "fibLevel" DOUBLE PRECISION NOT NULL,
    "fibRatio" DOUBLE PRECISION NOT NULL,
    "touchTime" TIMESTAMPTZ(6),
    "hookTime" TIMESTAMPTZ(6),
    "hookLow" DOUBLE PRECISION,
    "hookHigh" DOUBLE PRECISION,
    "hookClose" DOUBLE PRECISION,
    "goTime" TIMESTAMPTZ(6),
    "goType" VARCHAR(10),
    "entry" DOUBLE PRECISION,
    "stopLoss" DOUBLE PRECISION,
    "tp1" DOUBLE PRECISION,
    "tp2" DOUBLE PRECISION,
    "tp1Hit" BOOLEAN,
    "tp2Hit" BOOLEAN,
    "slHit" BOOLEAN,
    "tp1HitTime" TIMESTAMPTZ(6),
    "tp2HitTime" TIMESTAMPTZ(6),
    "slHitTime" TIMESTAMPTZ(6),
    "maxFavorable" DOUBLE PRECISION,
    "maxAdverse" DOUBLE PRECISION,
    "pTp1" DOUBLE PRECISION,
    "pTp2" DOUBLE PRECISION,
    "modelVersion" VARCHAR(64),
    "correlationScore" DOUBLE PRECISION,
    "vixLevel" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bhg_setups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "bhg_setups_setupId_key" ON "bhg_setups"("setupId");
CREATE INDEX IF NOT EXISTS "bhg_setups_direction_phase_idx" ON "bhg_setups"("direction", "phase");
CREATE INDEX IF NOT EXISTS "bhg_setups_go_time_idx" ON "bhg_setups"("goTime");
CREATE INDEX IF NOT EXISTS "bhg_setups_tf_go_time_idx" ON "bhg_setups"("timeframe", "goTime");

-- Create missing model registry table.
CREATE TABLE IF NOT EXISTS "mes_model_registry" (
    "id" BIGSERIAL NOT NULL,
    "modelName" VARCHAR(128) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "trainedAt" TIMESTAMPTZ(6) NOT NULL,
    "oofBrier" DOUBLE PRECISION,
    "oofLogLoss" DOUBLE PRECISION,
    "oofAuc" DOUBLE PRECISION,
    "trainRows" INTEGER NOT NULL,
    "features" JSONB NOT NULL,
    "hyperparams" JSONB,
    "artifactPath" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mes_model_registry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mes_model_registry_name_version_key" ON "mes_model_registry"("modelName", "version");
