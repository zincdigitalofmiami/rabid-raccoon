# MES 4h/1w Deploy Runbook (Corrected)

Date: 2026-02-27  
Status: **Corrected**

## Correction

`4h` and `1w` in this project are **training horizons**, not required persisted market-data timeframes.

That means:

1. Do not require `mkt_futures_mes_4h` / `mkt_futures_mes_1w` population for model training rollout.
2. Do not gate deployment on `4h/1w` table backfill counts.
3. Build targets from base series during dataset build (`1h`-anchored feature/target generation).

## Deployment Sequence (Training-Horizon Focus)

1. Verify target env and migration status.
2. Apply pending additive migrations.
3. Validate base ingestion tables (`mkt_futures_mes_1h`, `mkt_futures_mes_1d`, non-MES tables).
4. Rebuild dataset(s).
5. Run training smoke for horizons `1h,4h,1d,1w`.

## Required Commands

```bash
PRISMA_DIRECT=1 npx prisma migrate status
PRISMA_DIRECT=1 npx prisma migrate deploy
PRISMA_DIRECT=1 npx prisma migrate status

PRISMA_DIRECT=1 npx tsx scripts/db-counts.ts
npx tsx scripts/build-lean-dataset.ts --timeframe=1h
python3 scripts/train-core-forecaster.py --horizons=1h,4h,1d,1w --time-limit=300
```

## Validation Gates

1. Migration status is up-to-date on target DB.
2. Base MES/non-MES source tables are non-zero and date coverage is sane.
3. Dataset build completes without missing target-column errors.
4. Training smoke completes for requested horizons.

## Notes

1. Existing `4h/1w` Prisma models/tables may remain in schema history; they are not required for horizon training correctness.
2. If we fully remove those schema artifacts later, do it in a dedicated migration governance PR.
