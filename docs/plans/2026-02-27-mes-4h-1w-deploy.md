# MES 4h/1w Deploy Runbook (DB Routing + Migration + Backfill)

Date: 2026-02-27  
Scope: Deploy `W1` enum + `mkt_futures_mes_4h` + `mkt_futures_mes_1w`, then backfill and validate.

## 1. Preconditions

1. PR merged from branch `codex/db-routing-4h1w-cleanup`.
2. CI passed for the merge commit.
3. You have valid `DIRECT_URL` for the target environment.
4. You have `DATABENTO_API_KEY` for backfill.

## 2. Additive-Only Migration Gate

Run this before deploying migrations:

```bash
MIGRATION_PATH="prisma/migrations/20260227153000_add_mes_4h_1w_tables/migration.sql"
grep -nE "DROP TABLE|DROP COLUMN|ALTER COLUMN|DROP CONSTRAINT" "$MIGRATION_PATH"
```

Acceptance:
- No output from `grep`.
- Migration contains only enum add, table creates, and index creates.

## 3. Staging First

### 3.1 Preflight Target Check (Staging)

```bash
set -a && source .env.staging.local && set +a
node -e "console.log('DIRECT_URL host:', new URL(process.env.DIRECT_URL).host)"
PRISMA_DIRECT=1 npx prisma migrate status
```

Acceptance:
- Printed host matches staging DB.
- `migrate status` shows exactly the expected pending migration set.

### 3.2 Apply Migration (Staging)

```bash
PRISMA_DIRECT=1 npx prisma migrate deploy
PRISMA_DIRECT=1 npx prisma migrate status
```

Acceptance:
- `migrate deploy` exits cleanly.
- Follow-up `migrate status` reports "Database schema is up to date".

### 3.3 Schema Presence Check (Staging)

```bash
NODE_ENV=production DATABASE_URL="$DIRECT_URL" npx tsx scripts/db-counts.ts
```

Acceptance:
- `mkt_futures_mes_4h` exists.
- `mkt_futures_mes_1w` exists.
- Zero rows before backfill is acceptable.

### 3.4 Historical Backfill (Staging, Required)

```bash
NODE_ENV=production DATABASE_URL="$DIRECT_URL" npx tsx scripts/backfill-mes-1h-1d.ts --strict
```

Notes:
- Script default range is `2019-12-01` to now.
- Optional targeted range:
  - `--start=YYYY-MM-DDT00:00:00Z --end=YYYY-MM-DDT00:00:00Z`
- Manifest is always written (default under `reports/backfill/`), and can be retried:
  - `--retry-manifest=<manifest.json>` to rerun only failed/partial month chunks.
- Script auto-populates:
  - `mkt_futures_mes_1h` (from `ohlcv-1h`)
  - `mkt_futures_mes_1d` (from `ohlcv-1d`)
  - `mkt_futures_mes_4h` (derived from 1h)
  - `mkt_futures_mes_1w` (derived from 1d)
- Script is idempotent (`createMany(..., skipDuplicates: true)`).

### 3.5 Post-Backfill Validation (Staging)

```bash
NODE_ENV=production DATABASE_URL="$DIRECT_URL" npx tsx scripts/db-counts.ts
psql "$DIRECT_URL" -c "SELECT count(*) AS mes_1h FROM mkt_futures_mes_1h;"
psql "$DIRECT_URL" -c "SELECT count(*) AS mes_4h FROM mkt_futures_mes_4h;"
psql "$DIRECT_URL" -c "SELECT count(*) AS mes_1d FROM mkt_futures_mes_1d;"
psql "$DIRECT_URL" -c "SELECT count(*) AS mes_1w FROM mkt_futures_mes_1w;"
psql "$DIRECT_URL" -c "SELECT min(\"eventTime\") AS min_4h, max(\"eventTime\") AS max_4h FROM mkt_futures_mes_4h;"
psql "$DIRECT_URL" -c "SELECT min(\"eventDate\") AS min_1w, max(\"eventDate\") AS max_1w FROM mkt_futures_mes_1w;"
psql "$DIRECT_URL" -c "SELECT (SELECT count(*)::numeric FROM mkt_futures_mes_4h)/NULLIF((SELECT count(*) FROM mkt_futures_mes_1h),0) AS ratio_4h_to_1h;"
psql "$DIRECT_URL" -c "SELECT (SELECT count(*)::numeric FROM mkt_futures_mes_1w)/NULLIF((SELECT count(*) FROM mkt_futures_mes_1d),0) AS ratio_1w_to_1d;"
```

Acceptance:
- `mkt_futures_mes_4h` and `mkt_futures_mes_1w` counts are non-zero.
- `min_4h` and `min_1w` are near start of historical MES coverage.
- Ratio sanity:
  - `ratio_4h_to_1h` should be roughly near `0.25`.
  - `ratio_1w_to_1d` should be roughly near `0.20`.

## 4. Staging -> Production Checkpoint

Do not continue until all staging acceptance checks pass.

Required checkpoint decision:
1. Migration applied cleanly.
2. Backfill produced non-zero `4h/1w` with sane date coverage/ratios.
3. No unexpected DB errors in staging logs.

If any checkpoint fails, stop and execute rollback/fix steps in section 7 before touching production.

## 5. Production Execution

Repeat section 3.1 through 3.5 using production env values.

```bash
set -a && source .env.production.local && set +a
```

Run the same commands in the same order.

## 6. Dataset + Training Smoke (Pipeline Integrity Only)

Run after target environment data is healthy.

```bash
npx tsx scripts/build-lean-dataset.ts --timeframe=1h
python3 scripts/train-core-forecaster.py --horizons=1h,4h,1d,1w --time-limit=300
```

Important:
- This 300-second run is a pipeline integrity check only.
- Do not use these metrics for model selection, especially `1w`.

## 7. Rollback / Failure Playbook

### 7.1 Migration Fails Before Apply

Actions:
1. Stop.
2. Inspect migration error.
3. Fix in a new PR.
4. Re-run from section 3.1.

### 7.2 Migration Applied but Backfill Failed or Produced Bad Coverage

Actions:
1. Keep schema (migration is additive).
2. Clean only new derived tables if needed:

```sql
TRUNCATE TABLE mkt_futures_mes_4h, mkt_futures_mes_1w RESTART IDENTITY;
```

3. Re-run section 3.4 and 3.5.
4. Use targeted retry from manifest to avoid full-history reruns:

```bash
NODE_ENV=production DATABASE_URL="$DIRECT_URL" npx tsx scripts/backfill-mes-1h-1d.ts --retry-manifest=<manifest-path> --strict
```

5. If repeated failure, stop and investigate data/API availability before retry.

### 7.3 Wrong Database Targeted

Actions:
1. Stop immediately.
2. Record the host and migration history from `_prisma_migrations`.
3. Do not run additional migrations until impact is assessed.
4. Use environment-specific recovery procedures (backup/restore) if required.

### 7.4 App Regressions After Deploy

Actions:
1. Roll back application code deployment.
2. Keep DB schema in place (additive tables/enums are forward-compatible).
3. Re-validate data pipelines before re-promoting code.

## 8. Follow-Up Ticket (Separate Work)

Track fresh-DB bootstrap issue independently:
- Historical chain fails at migration `20260222103000_add_symbol_role_registry`.
- Do not bundle this fix into the 4h/1w deploy flow.
