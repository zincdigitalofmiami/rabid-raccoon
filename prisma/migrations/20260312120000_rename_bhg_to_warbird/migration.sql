-- Rename BHG → Warbird (enum + table + indexes)
-- Safe rename: ALTER TYPE / ALTER TABLE RENAME — no data loss

-- 1. Rename the enum type
ALTER TYPE "BhgPhase" RENAME TO "WarbirdPhase";

-- 2. Drop old indexes (they reference the old table name)
DROP INDEX IF EXISTS "bhg_setups_direction_phase_idx";
DROP INDEX IF EXISTS "bhg_setups_go_time_idx";
DROP INDEX IF EXISTS "bhg_setups_tf_go_time_idx";

-- 3. Rename the table
ALTER TABLE "bhg_setups" RENAME TO "warbird_setups";

-- 4. Re-create indexes with new names
CREATE INDEX "warbird_setups_direction_phase_idx" ON "warbird_setups"("direction", "phase");
CREATE INDEX "warbird_setups_go_time_idx" ON "warbird_setups"("goTime");
CREATE INDEX "warbird_setups_tf_go_time_idx" ON "warbird_setups"("timeframe", "goTime");
