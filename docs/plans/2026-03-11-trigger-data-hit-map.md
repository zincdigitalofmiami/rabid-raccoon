# 2026-03-11 Trigger Data Hit Map (What Hits Where and When)

**Status:** Active operational map for Trigger restart  
**As-of snapshot (UTC):** 2026-03-11T20:12:31Z  
**Scope:** Trigger-critical inputs only (data-first gate)

## 1. Team Flow (Who Does What)

1. **Kirk (architect/gatekeeper):** sets direction, approves scope, approves phase gates.
2. **Executor agent(s):** implements one approved slice at a time, runs proof commands, no scope drift.
3. **Reviewer/orchestrator:** validates evidence, calls go/no-go for next slice.
4. **Non-negotiable:** no trigger-base or decision rewiring until data gate is green.

## 2. Runtime Ownership Model

1. **Trigger runtime serving stays frontend-side (Vercel/Prisma).**
2. **Heavy processing is local-first** (feature math, correlation/math-heavy prep, replay, validation).
3. **Cloud remains serving/runtime source for dashboard paths.**
4. **Single writer per table** and idempotent publish paths are required.

## 3. Trigger-Critical Flow Map (Writer -> Destination -> Cadence)

| Input family | Current writer/owner | Destination DB/table(s) | Cadence / trigger | Notes |
| --- | --- | --- | --- | --- |
| MES authoritative 1m | `scripts/ingest-mes-live-1m.py` worker and/or `ingest-mkt-mes-1m` Inngest owner | Cloud `mkt_futures_mes_1m` | Minute cadence (market-open gated) | Authoritative upstream pull target |
| MES derived 15m/1h/4h/1d | Derived from stored MES 1m in MES refresh path | Cloud `mkt_futures_mes_15m`, `mkt_futures_mes_1h`, `mkt_futures_mes_4h`, `mkt_futures_mes_1d` | 15m every run; 1h/4h/1d bucket-gated | No direct Databento pull above 1m |
| Correlation basket daily bars (`NQ,RTY,ZN,CL,6E`) | `market-prices-futures-daily` | Cloud `mkt_futures_1d` | Daily scheduled ingest | Trigger uses basket state from DB |
| Econ calendar | `ingest-econ-calendar` | Cloud/local `econ_calendar` | Scheduled by Inngest | Stuck-run handling required |
| News signals | `ingest-news-signals` | Cloud/local `news_signals` | Scheduled by Inngest | Trigger news/regime gate input |
| Options daily proxies | `scripts/ingest-options.py` (manual) | `mkt_options_statistics_1d`, `mkt_options_ohlcv_1d` | Manual run today | Run-contract fixed; freshness still lagged historically |
| Symbol role membership | `symbol_roles` + `symbol_role_members` in DB | Snapshot fallback files | Manual `npm run registry:snapshot` | Snapshot must match serving DB parity |

## 4. Freshness Snapshot (What Hit Where and When)

### 4.1 Cloud direct DB (`DIRECT_URL`)

| Item | Max data timestamp (UTC) | Data lag (min) | Max ingested timestamp (UTC) | Ingest lag (min) |
| --- | --- | ---: | --- | ---: |
| `mkt_futures_mes_1m` | 2026-03-11T20:10:00Z | 1.90 | 2026-03-11T20:11:00Z | 0.90 |
| `mkt_futures_mes_15m` | 2026-03-11T19:45:00Z | 26.90 | 2026-03-11T19:57:00Z | 14.89 |
| `mkt_futures_mes_1h` | 2026-03-11T19:00:00Z | 71.90 | 2026-03-11T19:52:00Z | 19.89 |
| `mkt_futures_mes_4h` | 2026-03-11T16:00:00Z | 251.90 | 2026-03-11T19:52:01Z | 19.88 |
| `mkt_futures_1d:NQ` | 2026-03-10T00:00:00Z | 2651.90 | 2026-03-11T01:00:41Z | 1151.21 |
| `mkt_futures_1d:RTY` | 2026-03-10T00:00:00Z | 2651.90 | 2026-03-11T01:01:16Z | 1150.63 |
| `mkt_futures_1d:ZN` | 2026-03-10T00:00:00Z | 2651.90 | 2026-03-11T02:00:18Z | 1091.60 |
| `mkt_futures_1d:CL` | 2026-03-10T00:00:00Z | 2651.90 | 2026-03-11T03:00:46Z | 1031.12 |
| `mkt_futures_1d:6E` | 2026-03-10T00:00:00Z | 2651.90 | 2026-03-11T04:01:36Z | 970.29 |
| `econ_calendar` (`eventDate` max) | 2026-12-16T00:00:00Z | -401988.10 | 2026-03-11T15:02:32Z | 309.36 |
| `news_signals` | 2026-03-11T16:00:00Z | 251.90 | 2026-03-11T16:01:31Z | 250.37 |
| `mkt_options_statistics_1d` | 2026-02-24T00:00:00Z | 22811.90 | 2026-02-27T16:32:31Z | 17499.37 |
| `mkt_options_ohlcv_1d` | 2026-02-24T00:00:00Z | 22811.90 | 2026-02-27T08:36:50Z | 17975.05 |

### 4.2 Local DB (`LOCAL_DATABASE_URL`)

| Item | Max data timestamp (UTC) | Data lag (min) | Max ingested timestamp (UTC) | Ingest lag (min) |
| --- | --- | ---: | --- | ---: |
| `mkt_futures_mes_1m` | 2026-03-09T23:29:00Z | 2982.91 | 2026-03-09T23:42:44Z | 2969.17 |
| `mkt_futures_mes_15m` | 2026-03-06T01:45:00Z | 8606.91 | 2026-03-06T02:05:05Z | 8586.81 |
| `mkt_futures_mes_1h` | 2026-03-06T03:00:00Z | 8531.91 | 2026-03-06T06:00:05Z | 8351.81 |
| `mkt_futures_mes_4h` | NULL | NULL | NULL | NULL |
| `mkt_futures_1d:NQ` | 2026-03-05T00:00:00Z | 10151.91 | 2026-03-06T07:00:49Z | 8291.08 |
| `mkt_futures_1d:RTY` | 2026-03-05T00:00:00Z | 10151.91 | 2026-03-06T07:01:22Z | 8290.54 |
| `mkt_futures_1d:ZN` | 2026-03-05T00:00:00Z | 10151.91 | 2026-03-06T08:00:43Z | 8231.18 |
| `mkt_futures_1d:CL` | 2026-03-04T00:00:00Z | 11591.91 | 2026-03-05T09:00:24Z | 9611.50 |
| `mkt_futures_1d:6E` | 2026-03-04T00:00:00Z | 11591.91 | 2026-03-05T10:00:28Z | 9551.43 |
| `econ_calendar` (`eventDate` max) | 2026-12-16T00:00:00Z | -401688.09 | 2026-03-05T21:00:24Z | 8891.50 |
| `news_signals` | 2026-03-06T23:37:30Z | 7294.41 | 2026-03-06T23:56:05Z | 7275.82 |
| `mkt_options_statistics_1d` | 2026-02-24T00:00:00Z | 23111.91 | 2026-02-27T16:32:31Z | 17799.38 |
| `mkt_options_ohlcv_1d` | 2026-02-24T00:00:00Z | 23111.91 | 2026-02-27T15:10:04Z | 17881.84 |

## 5. Ingestion Run Status Snapshot (Latest per job)

### 5.1 Cloud direct DB

- `mes-live-1m-worker`: `RUNNING` (latest started `2026-03-11T17:51:25Z`)
- `market-prices-futures-daily`: `COMPLETED` (`2026-03-11T04:01:47Z -> 04:01:55Z`)
- `ingest-news-signals`: `COMPLETED` (`2026-03-11T16:00:46Z -> 16:01:33Z`)
- `ingest-econ-calendar`: latest `FAILED` (`2026-03-11T15:00:22Z -> 20:11:27Z`, reason: stale RUNNING closed by maintenance)
- `gpr-index`: `FAILED` (`spawnSync /bin/sh EPIPE`)
- `ingest-options`: last `FAILED` on `2026-02-27T16:20:30Z` (manual termination note)

### 5.2 Local DB

- `ingest-options`: latest `COMPLETED` dry-run (`id=356`, `2026-03-11T19:57:34Z -> 19:57:40Z`)
- `market-prices-futures-daily`: latest `COMPLETED` on `2026-03-06`
- `ingest-news-signals`: latest `COMPLETED` on `2026-03-05`
- `ingest-econ-calendar`: latest `FAILED` (`2026-03-05T21:00:00Z -> 2026-03-11T20:11:26Z`, stale RUNNING closed)
- `gpr-index`: latest `FAILED` (`spawnSync /bin/sh EPIPE`)

## 6. Symbol Role Parity (DB vs Snapshot)

### Roles checked

- `CORRELATION_SET`
- `ANALYSIS_DEFAULT`
- `OPTIONS_PARENT`

### Result as-of snapshot time

1. `CORRELATION_SET`: direct DB == local DB == snapshot (`MES,NQ,RTY,ZN,CL,6E`)
2. `ANALYSIS_DEFAULT`: local DB == snapshot, direct DB mismatch
3. `OPTIONS_PARENT`: local DB == snapshot, direct DB mismatch (direct has none active)

## 7. Data Gate Interpretation

1. Cloud MES intraday path is live and current enough for runtime consumption.
2. Local parity is not current for trigger-critical tables.
3. Options daily tables remain historically stale unless non-dry-run ingest is resumed.
4. Role parity is only partially solved because snapshot was generated from local state and does not fully match direct DB.

## 8. Immediate Gate Actions (Before Trigger Base Rewrite)

1. Decide single canonical DB for snapshot generation (if runtime serves from cloud, regenerate snapshot from cloud).
2. Restore local parity intentionally (or formally scope local to replay-only) so there is no implicit split-brain.
3. Resolve repeated `ingest-econ-calendar` stale-run behavior in scheduler path.
4. Resolve `gpr-index` `EPIPE` reliability issue.
5. Confirm non-dry-run options ingestion plan and cadence.

### 8.2 Operational Stance Lock (2026-03-11)

- **Chosen stance for this pass:** local scoped to replay-only; no parity guarantee.
- **Implementation boundary:** no new replication framework in this pass; only cloud-canonical runtime evidence plus bounded reliability/freshness fixes.

## 9. Command Bundle Used For This Snapshot

```bash
# Load env
set -a; source .env.local; set +a

# Freshness (direct + local)
psql "$DIRECT_URL" -c "..."
psql "$LOCAL_DATABASE_URL" -c "..."

# Latest ingestion runs (direct + local)
psql "$DIRECT_URL" -c "..."
psql "$LOCAL_DATABASE_URL" -c "..."

# Role parity (direct/local vs snapshot)
psql "$DIRECT_URL" -c "...symbol_role_members..."
psql "$LOCAL_DATABASE_URL" -c "...symbol_role_members..."
npm run registry:snapshot
```

## 10. Gate Update (2026-03-11T21:30:00Z)

### 10.1 Section 8 Status

1. `8.1` **PASS** — snapshot regenerated from cloud/direct DB and parity rechecked:
   - `CORRELATION_SET`: `MES,NQ,RTY,ZN,CL,6E`
   - `ANALYSIS_DEFAULT`: `MES,NQ,YM,RTY,VX,US10Y,ZN,DX,GC,CL`
   - `OPTIONS_PARENT`: `ES.OPT,EUU.OPT,HXE.OPT,JPU.OPT,LO.OPT,NQ.OPT,OB.OPT,OG.OPT,OH.OPT,OKE.OPT,ON.OPT,OZB.OPT,OZF.OPT,OZN.OPT,SO.OPT`
2. `8.2` **LOCKED** — local is replay-only for this pass (no parity guarantee).
3. `8.3` **PASS** — `ingest-econ-calendar` has no stale `RUNNING` rows in direct/local snapshots.
4. `8.4` **PASS** — `gpr-index` now prefers `.venv-finance/bin/python` then `python3`; latest direct run `id=623` is terminal `COMPLETED` (`2026-03-11T21:22:54Z -> 21:22:55Z`, `rowsProcessed=28`, `rowsInserted=7`).
5. `8.5` **FAIL (RED)** — options `eventDate` freshness ceiling not advanced.

### 10.2 Options Freshness Truth (8.5)

Source coverage from local parquet inputs:

- `datasets/options-ohlcv/*`: global max source ts `2026-02-24T00:00:00Z`
- `datasets/options-statistics/*`: global max source ts `2024-07-31T22:42:50Z`

Direct table maxima after bounded non-dry-run ingest:

- `mkt_options_ohlcv_1d`: `max(eventDate)=2026-02-24`, `max(ingestedAt)=2026-03-11T20:41:34Z`
- `mkt_options_statistics_1d`: `max(eventDate)=2026-02-24`, `max(ingestedAt)=2026-03-11T20:42:56Z`

Blocker cause:

- Runtime Databento refresh is not executable in this workspace because `DATABENTO_API_KEY` is missing from `.env.local`.
