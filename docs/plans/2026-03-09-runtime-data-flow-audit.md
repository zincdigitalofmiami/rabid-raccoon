# 2026-03-09 Runtime Data-Flow Audit

Audit completed against current workspace state and live runtime signals on Monday, March 9, 2026.

## Prisma + Local DB State

- Prisma datasource switching is explicit: `PRISMA_LOCAL=1` uses `LOCAL_DATABASE_URL`, else `DIRECT_URL` in [prisma.config.ts](../../prisma.config.ts#L6).
- Runtime Prisma is hybrid direct/Accelerate; direct is default, Accelerate is opt-in (`USE_ACCELERATE=1`) in [src/lib/prisma.ts](../../src/lib/prisma.ts#L21).
- A separate raw `pg.Pool` bypass exists in [src/lib/direct-pool.ts](../../src/lib/direct-pool.ts#L23).
- `npx prisma migrate status` against direct/cloud DB was up to date with 29 migrations.
- `PRISMA_LOCAL=1 npx prisma migrate status` against local DB showed drift.
- Missing locally: [20260309134500_update_trigger_correlation_set](../../prisma/migrations/20260309134500_update_trigger_correlation_set/migration.sql#L18).
- Local-only migration present in DB history: `20260303180000_add_mkt_futures_mes_1m`.

### Direct DB vs Local DB

- Base tables: direct `38`, local `40`.
- Local-only tables: `mkt_futures_mes_4h`, `mkt_futures_mes_1w` (both `0` rows).

### Freshness Gap (UTC max `eventTime`)

- `mkt_futures_mes_1m`: direct `2026-03-09T03:29:00Z`, local `2026-03-06T01:49:00Z`.
- `mkt_futures_mes_15m`: direct `2026-03-09T03:15:00Z`, local `2026-03-06T01:45:00Z`.

### Symbol-Role Drift Due To Migration Mismatch

- Direct `CORRELATION_SET` enabled: `MES,NQ,RTY,ZN,CL,6E`.
- Local `CORRELATION_SET` enabled: `MES,NQ,VX,DX`.
- Migration code: [20260309134500_update_trigger_correlation_set](../../prisma/migrations/20260309134500_update_trigger_correlation_set/migration.sql#L18).

## Scheduler / Webhook / Worker Ingress + Write Flows

| Flow | Source | Trigger / Schedule | Code location | Prisma model(s) / DB table(s) | Ops | Destination | Direction | Active now |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Inngest webhook ingress | Inngest Cloud | HTTP POST to `/api/inngest` | [src/app/api/inngest/route.ts](../../src/app/api/inngest/route.ts#L51) | Dispatch only | Receive/dispatch | Inngest functions | One-way ingress | Configured; prod currently returning `400` |
| MES 15m refresh | Databento | `5,20,35,50 * * * 1-5` | [mkt-mes-15m.ts](../../src/inngest/functions/mkt-mes-15m.ts#L9), [mes15m-refresh.ts](../../src/lib/mes15m-refresh.ts#L225) | Raw SQL tables `mkt_futures_mes_1m`, `mkt_futures_mes_15m` | Upsert | Local/direct Postgres | One-way | Scheduled path exists; depends on `/api/inngest` health |
| MES 1h ingest | Databento | `0 0 * * *` | [mkt-mes-1h.ts](../../src/inngest/functions/mkt-mes-1h.ts#L9), [ingest-market-prices-daily.ts](../../scripts/ingest-market-prices-daily.ts#L296) | `MktFuturesMes1h`, `IngestionRun` / `mkt_futures_mes_1h`, `ingestion_runs` | `createMany` + run logging | Postgres | One-way | Was active (recent runs seen), currently gated by webhook `400`s |
| Daily market role ingests (equity / treasury / commodities / fx-rates) | Databento | `0 1`, `0 2`, `0 3`, `0 4` daily | [daily-market-role-ingest.ts](../../src/inngest/functions/daily-market-role-ingest.ts#L9), [ingest-market-prices-daily.ts](../../scripts/ingest-market-prices-daily.ts#L172) | `MktFutures1h`, `MktFutures1d`, `IngestionRun` / `mkt_futures_1h`, `mkt_futures_1d`, `ingestion_runs` | Read + `createMany` + log update | Postgres | One-way | Was active (high run volume), currently gated by webhook `400`s |
| FRED econ domain ingests (10 funcs) | FRED API | `0 5` through `0 14` hourly | [econ-rates.ts](../../src/inngest/functions/econ-rates.ts#L15) pattern for all 10, [ingest-fred-complete.ts](../../scripts/ingest-fred-complete.ts#L233) | `IngestionRun` + raw SQL into `economic_series` + `econ_*_1d` domain tables | Upsert + run logging | Postgres | One-way | Was active; now likely blocked by webhook `400`s |
| Econ calendar + earnings | FRED releases + Yahoo `quoteSummary` | `0 15 * * *` | [econ-calendar.ts](../../src/inngest/functions/econ-calendar.ts#L42), [src/lib/ingest/econ-calendar.ts](../../src/lib/ingest/econ-calendar.ts#L274) | `EconCalendar`, `IngestionRun` / `econ_calendar`, `ingestion_runs` | Upsert + log update | Postgres | One-way | Was active; currently has `RUNNING` records not closed in recent runs |
| News signals | Google News RSS | `0 16 * * *` | [news-signals.ts](../../src/inngest/functions/news-signals.ts#L12), [news-scrape.ts](../../src/lib/news-scrape.ts#L48) | `NewsSignal`, `IngestionRun` / `news_signals`, `ingestion_runs` | Upsert + log update | Postgres | One-way | Scheduled path exists |
| Alt news feeds | Fed / SEC / ECB / BEA / EIA / CFTC RSS | `0 17 * * *` | [alt-news.ts](../../src/inngest/functions/alt-news.ts#L9), [ingest-alt-news-feeds.ts](../../scripts/ingest-alt-news-feeds.ts#L408) | `EconNews1d`, `PolicyNews1d`, `MacroReport1d`, `DataSourceRegistry`, `IngestionRun` | `createMany` / upsert / update | Postgres | One-way | Scheduled path exists |
| FRED news feeds | FRED RSS | `15 17 * * *` | [fred-news.ts](../../src/inngest/functions/fred-news.ts#L9), [ingest-fred-news.ts](../../scripts/ingest-fred-news.ts#L268) | `EconNews1d`, `DataSourceRegistry`, `IngestionRun` | `createMany` / upsert / update | Postgres | One-way | Scheduled path exists |
| Measured moves | MES candles in DB | `0 18 * * *` | [measured-moves.ts](../../src/inngest/functions/measured-moves.ts#L9), [ingest-mm-signals.ts](../../scripts/ingest-mm-signals.ts#L195) | `MeasuredMoveSignal`, `IngestionRun` / `measured_move_signals`, `ingestion_runs` | `createMany` + log update | Postgres | Internal one-way | Scheduled path exists |
| Compute signal pipeline | DB candles + Databento + Python volume features | `13,28,43,58 * * * 1-5` and event `econ/event.approaching` | [compute-signal.ts](../../src/inngest/functions/compute-signal.ts#L350), [compute-volume-features.py](../../scripts/compute-volume-features.py#L65), [bhg-setup-recorder.ts](../../src/lib/bhg-setup-recorder.ts#L21), [trade-recorder.ts](../../src/lib/trade-recorder.ts#L26) | `BhgSetup` + raw SQL to `scored_trades` + raw SQL to `mkt_futures_mes_1m` | Upsert / update / insert | Postgres + in-memory cache | Internal + external one-way | Scheduled path exists; event emitter for `econ/event.approaching` not found |
| Trade outcome resolver | DB only | `*/15 * * * 1-5` | [check-trade-outcomes.ts](../../src/inngest/functions/check-trade-outcomes.ts#L14), [outcome-tracker.ts](../../src/lib/outcome-tracker.ts#L133) | `BhgSetup`, `ScoredTrade` / `bhg_setups`, `scored_trades` | `update` / `updateMany` | Postgres | Internal in-place | Scheduled path exists |
| Symbol coverage auditor | Databento + symbol snapshot | `0 6 * * 0` | [check-symbol-coverage.ts](../../src/inngest/functions/check-symbol-coverage.ts#L102) | `SymbolRoleMember`, `Symbol`, `CoverageCheckLog`, `IngestionRun` / `symbol_role_members`, `symbols`, `coverage_check_log`, `ingestion_runs` | Read + create + update | Postgres | Internal + external one-way | Scheduled path exists |
| GPR ingest | Matteo Iacoviello XLS | `0 19 * * *` | [src/inngest/functions/ingest-gpr-index.ts](../../src/inngest/functions/ingest-gpr-index.ts#L9), [scripts/ingest-gpr-index.ts](../../scripts/ingest-gpr-index.ts#L184) | `GeopoliticalRisk`, `IngestionRun` / `geopolitical_risk_1d`, `ingestion_runs` | `createMany` + log update | Postgres | One-way | Scheduled path exists |
| Trump effect ingest | Federal Register + FRED EPU | `30 19 * * *` | [src/inngest/functions/ingest-trump-effect.ts](../../src/inngest/functions/ingest-trump-effect.ts#L9), [scripts/ingest-trump-effect.ts](../../scripts/ingest-trump-effect.ts#L268) | `TrumpEffect`, `IngestionRun` / `trump_effect_1d`, `ingestion_runs` | `createMany` + log update | Postgres | One-way | Scheduled path exists |
| Backfill all MES timeframes | Databento | Event `backfill/mes.all-timeframes` only | [backfill-mes.ts](../../src/inngest/backfill-mes.ts#L137) | `MktFuturesMes15m`, `MktFuturesMes1h`, `MktFuturesMes1d`, `IngestionRun` | `createMany` + log create | Postgres | One-way | On-demand only |

## API Route Transfer Map

- Route inventory location: [src/app/api](../../src/app/api).
- Server actions: none (`"use server"` not found in `src`).

### Write / Trigger Routes

- `/api/inngest` webhook dispatcher: [route.ts](../../src/app/api/inngest/route.ts#L51).
- `/api/ingest/econ-calendar` manual ingestion trigger: [route.ts](../../src/app/api/ingest/econ-calendar/route.ts#L8).
- `/api/news/scrape` manual ingestion trigger: [route.ts](../../src/app/api/news/scrape/route.ts#L8).
- `/api/news/scrape-reports` direct `news_signals` upsert path: [route.ts](../../src/app/api/news/scrape-reports/route.ts#L15).

### Read / Egress Routes

- SSE live reads via raw SQL: `/api/live/mes`, `/api/live/mes1m`, `/api/live/mes15m` using [mes-live-queries.ts](../../src/lib/mes-live-queries.ts#L30).
- File-backed transfer: `/api/correlation`, `/api/mes/correlation` read `public/daily-correlations.json` via [correlation route](../../src/app/api/correlation/route.ts#L160) and [mes/correlation route](../../src/app/api/mes/correlation/route.ts#L31).
- File-backed transfer: `/api/ml-forecast` reads `public/ml-predictions.json` via [route.ts](../../src/app/api/ml-forecast/route.ts#L17).
- Prisma read routes: `/api/gpr`, `/api/pivots/mes`, `/api/setups/history`, `/api/analyse/chart`, `/api/analyse/trades`.
- Analysis / forecast routes (`/api/forecast`, `/api/market-data`, `/api/market-data/batch`, `/api/setups`, `/api/trades/upcoming`, other `/api/analyse/*`) are transfer / read paths from DB + computed features + optional AI providers to API consumers.

## CLI / Script / Seed / Migration Data Movement

| Flow | Source | Trigger | Code location | Models / Tables | Ops | Destination | Direction | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Full FRED ingest (raw `pg` bypass) | FRED API | Manual CLI (`ingest:fred:complete`) | [scripts/ingest-fred-complete.ts](../../scripts/ingest-fred-complete.ts#L400) | Raw SQL `economic_series`, `econ_*_1d`, `ingestion_runs`, `data_source_registry` | Insert / upsert / delete (`truncate` mode) | Postgres | One-way | Active manual path |
| Market daily ingest | Databento | Manual CLI + called by Inngest | [scripts/ingest-market-prices-daily.ts](../../scripts/ingest-market-prices-daily.ts#L296) | `mkt_futures_mes_1h`, `mkt_futures_1h`, `mkt_futures_1d`, `ingestion_runs` | `createMany` / update | Postgres | One-way | Active |
| Older market ingest | Databento | Manual CLI (`ingest:market`) | [scripts/ingest-market-prices.ts](../../scripts/ingest-market-prices.ts#L543) | `mkt_futures_mes_1h`, `mkt_futures_1d`, symbol registry tables, `ingestion_runs` | `createMany` / upsert / update | Postgres | One-way | Legacy-manual |
| Macro ingest (older split) | FRED | Manual CLI (`ingest:macro`) | [scripts/ingest-macro-indicators.ts](../../scripts/ingest-macro-indicators.ts#L258) | `econ_rates_1d` etc, `economic_series`, `ingestion_runs` | `createMany` / upsert / update | Postgres | One-way | Legacy-manual |
| MES live polling writer | Databento | Manual long-running loop | [scripts/ingest-mes-live-15m.ts](../../scripts/ingest-mes-live-15m.ts#L136), [scripts/ingest-mes-live-stream.ts](../../scripts/ingest-mes-live-stream.ts#L17) | `mkt_futures_mes_15m`, `ingestion_runs` | `createMany` / upsert / update | Postgres | One-way | Manual background worker |
| Backfills (TS) | Databento | Manual | [scripts/backfill-mes-15m.ts](../../scripts/backfill-mes-15m.ts#L87), [scripts/backfill-mes-1h-1d.ts](../../scripts/backfill-mes-1h-1d.ts#L180), [scripts/backfill-futures-all.ts](../../scripts/backfill-futures-all.ts#L195) | MES / non-MES market tables | `createMany` | Postgres | One-way | Manual |
| Backfills (Python raw SQL) | Databento | Manual | [scripts/backfill-mes-1m.py](../../scripts/backfill-mes-1m.py#L112), [scripts/backfill-mes-1m-from-disk.py](../../scripts/backfill-mes-1m-from-disk.py#L154) | `mkt_futures_mes_1m` | UPSERT | Postgres | One-way | Manual |
| Options batch + convert + aggregate + ingest | Databento batch + raw DBN files | Manual staged pipeline | [submit-options-batch.py](../../scripts/submit-options-batch.py#L24), [check-options-jobs.py](../../scripts/check-options-jobs.py#L30), [convert-options-raw.py](../../scripts/convert-options-raw.py#L99), [aggregate-options.py](../../scripts/aggregate-options.py#L171), [ingest-options.py](../../scripts/ingest-options.py#L220) | `mkt_options_ohlcv_1d`, `mkt_options_statistics_1d` plus attempted `ingestionRun` tracking | File transform + UPSERT | Filesystem and Postgres | One-way | Manual; ingestion-run tracking likely stale naming |
| Fusion import | External Fusion Postgres | Manual | [scripts/import-fusion-econ.ts](../../scripts/import-fusion-econ.ts#L735) | Many `econ_*`, `economic_series`, `policy_news_1d`, `ingestion_runs` | `createMany` / upsert / update | Postgres | One-way | Env-gated (`FUSION_DATABASE_URL`) |
| Symbol snapshot sync | Postgres symbol registry | Manual (`registry:snapshot`) | [generate-symbol-registry-snapshot.ts](../../scripts/generate-symbol-registry-snapshot.ts#L112), [scripts/lib/registry.py](../../scripts/lib/registry.py#L21) | `symbols`, `symbol_role_members`, `symbol_mappings` | Read + file write | `src/lib/symbol-registry/snapshot.ts/.json` | One-way DB -> file | Active manual sync |
| Correlation sync | Postgres | Manual | [compute-daily-correlations.py](../../scripts/compute-daily-correlations.py#L242) | Reads `mkt_futures_mes_1d`, `mkt_futures_1d`, `econ_vol_indices_1d`, `econ_fx_1d` | Read + file write | `public/daily-correlations.json` | One-way DB -> file -> API | Active manual sync |
| Dataset / model / export pipeline | Postgres + datasets | Manual | [build-complete-dataset.ts](../../scripts/build-complete-dataset.ts#L646), [build-15m-dataset.ts](../../scripts/build-15m-dataset.ts#L554), [build-1m-dataset.ts](../../scripts/build-1m-dataset.ts#L754), [build-lean-dataset.ts](../../scripts/build-lean-dataset.ts#L3019), [predict.py](../../scripts/predict.py#L291) | Mostly DB reads; optional `bhg_setups` upsert in BHG builder | Read / export / train / file write | `datasets/`, `models/`, `public/ml-predictions.json` | One-way DB -> FS -> API | Active local research path |
| Seed / update symbol catalog | Manual inputs | Manual | [seed-new-symbols.ts](../../scripts/seed-new-symbols.ts#L18), [add-new-symbols.ts](../../scripts/add-new-symbols.ts#L4) | `Symbol` (`symbols`) | Upsert / update | Postgres | One-way | Manual |
| Raw DDL helper | Manual | Manual | [create-scored-trades.ts](../../scripts/create-scored-trades.ts#L16) | Table `scored_trades` | `CREATE TABLE` / `CREATE INDEX` | Postgres schema | One-way | One-off / manual |

## Vercel Cron / Deployment / Runtime Confirmation

- Vercel cron definitions are empty:
  - [vercel.json](../../vercel.json#L1) contains no crons.
  - `vercel api /v9/projects/...` returned `crons.definitions: []`.
- Project linkage: [.vercel/project.json](../../.vercel/project.json#L1).

### Production Log Evidence

- `/api/inngest` POST attempts were sampled as `400` only.
- Sample details: 100 log rows, 50 unique request IDs, all `400`, observed on March 9, 2026 UTC.

### Local Runtime / Process Evidence

- `inngest-cli dev -u http://localhost:3001/api/inngest` process was running.
- No listener on `3001` at audit time.
- Listeners were present on `5432`, `8288`, and `8289`.
- `crontab -l` on the local machine had unrelated `ZINC-FUSION` jobs and no `rabid-raccoon` cron entries.

## Prisma Primary Write Layer?

- Prisma is the main write layer for many app and script flows (`news_signals`, `econ_calendar`, `measured_move_signals`, daily market ingests, symbol registry updates).
- Prisma is not exclusive, and high-volume paths explicitly bypass it:
  - Raw `pg` in [mes15m-refresh.ts](../../src/lib/mes15m-refresh.ts#L225), [trade-recorder.ts](../../src/lib/trade-recorder.ts#L26), and [ingest-fred-complete.ts](../../scripts/ingest-fred-complete.ts#L47).
  - Python direct writes via `psycopg2` / SQLAlchemy in options and backfill scripts.
- Net: the architecture is hybrid Prisma + direct SQL, with direct SQL used where throughput or operational constraints drove bypass.

## One-Way vs Bidirectional

- External ingest paths are one-way into DB.
- API and file exports are one-way out of DB to clients / files.
- Internal state updaters (`check-trade-outcomes`, `check-symbol-coverage`) are in-place DB mutations, not external bidirectional sync.
- No automated two-way replication between local and cloud DBs was found.

## Real Architecture Today (Concise)

- Inngest is the orchestrator for scheduled ingestion and signal jobs, entered via `/api/inngest`.
- Vercel Cron is not used.
- Data lands in Postgres through mixed Prisma and direct SQL writers.
- API routes are mostly read / transfer surfaces (SSE, analytics, file-backed endpoints), with a few manual ingest triggers.
- Local research / training is file-centric: DB -> datasets / models / public JSON.
- Current operational risk: scheduled Inngest webhooks are hitting production but returning `400`, so cron-defined flows are configured yet currently unhealthy.

## Uncertainties / Gaps

- I could not inspect Inngest cloud dashboard internals such as registration state or failed-run reasons beyond HTTP `400`.
- Vercel log analysis is sampled and includes duplicate log lines per request ID.
- Manual scripts may also run from other machines or environments not visible from this workspace.
- Some paths appear stale or broken:
  - `ingest:mes:backfill` points to a missing script.
  - deprecated monolith file not registered.
  - local migration divergence remains unresolved.

## Follow-Up Artifact Options

If needed after this audit, the next artifact should be exactly one of:

1. A machine-readable flow inventory (`data-flow-audit-2026-03-09.md` + CSV) in the repo.
2. A remediation checklist to restore healthy scheduled execution (`/api/inngest` `400` issue, migration / env drift).
3. A local-vs-cloud parity action plan with exact commands and rollback notes.
