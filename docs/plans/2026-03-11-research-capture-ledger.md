# 2026-03-11 Research Capture Ledger

**Status:** Active  
**Intent:** Preserve researched work, decisions, proofs, and blockers in one durable location.  
**Rule:** Append-only. Do not rewrite historical conclusions; add dated updates.

## 1. Canonical Research Stack

Use this order when restarting context:

1. [AGENTS.md](/Volumes/Satechi%20Hub/rabid-raccoon/AGENTS.md)
2. [2026-03-09-trigger-news-regime-spec.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-news-regime-spec.md)
3. [2026-03-09-trigger-core-contract.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-core-contract.md)
4. [2026-03-11-trigger-data-hit-map.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-11-trigger-data-hit-map.md)
5. [2026-03-11-warbird-trigger-restart-checklist.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-11-warbird-trigger-restart-checklist.md)
6. [2026-03-09-runtime-data-flow-audit.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-runtime-data-flow-audit.md)
7. [2026-03-08-pre-phase1-trigger-governance-approval.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/handoffs/2026-03-08-pre-phase1-trigger-governance-approval.md)

## 2. High-Signal Language Lock (Do Not Lose)

The approved trigger language is broader than only VIX/CPI and already includes:

1. Macro baselines + reaction features (`vol spikes`, `policy actions`, `cross-asset velocity`) in [AGENTS.md:379](/Volumes/Satechi%20Hub/rabid-raccoon/AGENTS.md:379).
2. Regime-dependent news interpretation and tiered event model in [2026-03-09-trigger-news-regime-spec.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-news-regime-spec.md).
3. Correlation and volume/liquidity as co-equal confirmation layers in [2026-03-09-trigger-core-contract.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-core-contract.md).
4. Expanded volatility/regime overlays (`VIX`, `VXV`, `OVX`, `VXD`, stress categories, cross-asset reaction windows) in [2026-03-08-pre-phase1-trigger-governance-approval.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/handoffs/2026-03-08-pre-phase1-trigger-governance-approval.md).

## 3. Required Capture Block For Every Execution Slice

Every completed slice must append a short block in this format:

```md
### YYYY-MM-DD — <lane/slice name>
- Scope:
- Why:
- Files changed:
- Runtime/DB proof:
- Commands run:
- Result:
- Blockers:
- Next gate:
```

Minimum proof standards:

1. Include exact timestamps for freshness-sensitive claims.
2. Include concrete command output summary (not just "passed").
3. Separate cloud/direct DB truth from local DB truth.
4. Explicitly call out unknowns instead of inferring.

## 4. Current Active Lanes (Reference Map)

1. MES chart transport hardening (polling contract, frozen UI contract preserved): see commit history around `fix: switch mes chart transport to short polling`.
2. MES 1m worker ownership and derived timeframe hardening (1m authoritative; derived 15m/1h/4h/1d paths): see 2026-03-10 and 2026-03-11 MES runbook/docs set.
3. Warbird trigger/decision restart (data-first gate): see hit-map + restart checklist.

## 5. Update Discipline

1. Do not create parallel "source-of-truth" docs for the same lane.
2. If a new doc is added, link it here and in the lane checklist in the same pass.
3. If a claim changes, append an update entry with date/time and reason.
4. Keep this file concise, factual, and restart-friendly.

## 6. Execution Entries

### 2026-03-11 — Trigger Data Gate Baseline and Contract Hardening
- Scope: lock a data-first baseline for Warbird trigger restart, fix ingestion run-contract drift, validate role parity, and capture cloud/local freshness.
- Why: trigger-base and decision rewiring are blocked until trigger inputs and ingestion status are trustworthy.
- Files changed:
  - `/Volumes/Satechi Hub/rabid-raccoon/scripts/ingest-options.py`
  - `/Volumes/Satechi Hub/rabid-raccoon/scripts/ingest-market-prices-daily.ts`
  - `/Volumes/Satechi Hub/rabid-raccoon/src/lib/prisma.ts`
  - `/Volumes/Satechi Hub/rabid-raccoon/src/lib/symbol-registry/snapshot.ts`
  - `/Volumes/Satechi Hub/rabid-raccoon/src/lib/symbol-registry/snapshot.json`
  - `/Volumes/Satechi Hub/rabid-raccoon/scripts/ingest-gpr-index.ts`
  - `/Volumes/Satechi Hub/rabid-raccoon/docs/plans/2026-03-11-trigger-data-hit-map.md`
  - `/Volumes/Satechi Hub/rabid-raccoon/docs/plans/2026-03-11-warbird-trigger-restart-checklist.md`
- Runtime/DB proof:
  - Trigger hit-map baseline anchored at `2026-03-11T20:12:31Z` in [2026-03-11-trigger-data-hit-map.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-11-trigger-data-hit-map.md).
  - Cloud/direct MES intraday path was live enough for runtime (`mkt_futures_mes_1m` near-current), while local trigger-critical tables were materially stale.
  - `ingest-options` run-contract mismatch was corrected to `ingestion_runs` contract shape and dry-run logging completed cleanly.
  - `ingest-econ-calendar` stale `RUNNING` behavior was bounded to terminal status handling in the audited pass.
  - `gpr-index` shell `EPIPE` mode was removed, but host dependency failure (`xlrd` missing) remained a terminal blocker.
- Commands run:
  - `git diff --check`
  - `npx tsc --noEmit --pretty false`
  - `.venv-finance/bin/python scripts/ingest-options.py --dry-run --parent ES_OPT`
  - `psql "$DIRECT_URL" -c "...freshness / ingestion_runs / role parity..."`
  - `psql "$LOCAL_DATABASE_URL" -c "...freshness / ingestion_runs / role parity..."`
  - `npm run registry:snapshot`
- Result: **partial pass**. Data gate advanced with stronger run-contract and parity controls, but restart gate not yet green.
- Blockers:
  - `gpr-index` runtime still blocked by missing `xlrd` on host.
  - Local trigger-critical freshness/parity remains behind cloud in current operating stance.
  - Options tables advanced on ingest timestamp, but historical `eventDate` freshness remained stale in the audited window.
- Next gate:
  - Close `gpr-index` dependency blocker.
  - Re-run bounded freshness/ingestion parity audit and append timestamped evidence.
  - Confirm trigger data gate green before any trigger-base replacement slice.

### 2026-03-11 — Gate Blocker Closure Attempt (8.4/8.5)
- Scope: close remaining data-gate blockers only (`gpr-index` reliability and options true freshness), no trigger/decision rewiring.
- Why: restart remains blocked until Section 8.4 and 8.5 are resolved to PASS or explicit RED with evidence.
- Files changed:
  - `/Volumes/Satechi Hub/rabid-raccoon/scripts/ingest-gpr-index.ts`
  - `/Volumes/Satechi Hub/rabid-raccoon/docs/plans/2026-03-11-trigger-data-hit-map.md`
- Runtime/DB proof:
  - `gpr-index` direct latest run is terminal `COMPLETED` (`id=623`, `2026-03-11T21:22:54Z -> 21:22:55Z`, `rowsProcessed=28`, `rowsInserted=7`).
  - Source options coverage remains capped: `options-ohlcv` max source ts `2026-02-24T00:00:00Z`, `options-statistics` max source ts `2024-07-31T22:42:50Z`.
  - Direct options tables remain `max(eventDate)=2026-02-24` for both `mkt_options_ohlcv_1d` and `mkt_options_statistics_1d`; only `ingestedAt` moved.
  - Databento refresh cannot run in this workspace because `DATABENTO_API_KEY` is missing in `.env.local`.
- Commands run:
  - `npx tsx scripts/ingest-gpr-index.ts --days-back 30`
  - `.venv-finance/bin/python - <<'PY' ... scan datasets/options-ohlcv and datasets/options-statistics ... PY`
  - `psql "$DIRECT_URL" -c "... latest ingestion_runs for gpr-index/ingest-options/ingest-econ-calendar ..."`
  - `psql "$DIRECT_URL" -c "... max(eventDate), max(ingestedAt) options tables ..."`
  - `psql "$DIRECT_URL" -c "... trigger-critical max_data_ts/max_ingested_ts ..."`
- Result:
  - `8.4` **PASS**
  - `8.5` **RED**
- Blockers:
  - Missing Databento credentials in local runtime (`DATABENTO_API_KEY`) prevents refreshing source coverage beyond current parquet ceiling.
- Next gate:
  - Provide `DATABENTO_API_KEY`, refresh options source files, rerun non-dry-run options ingest to direct DB, and re-evaluate `max(eventDate)` for both options tables.
