# ARCHITECTURE.md — Rabid Raccoon System Design

Read AGENTS.md first. This document describes how the system works. AGENTS.md describes how you work on the system.

## Current Operating Model (2026-03-08)

- **Production path**: cloud DB + cloud runtime for the app, deployed `/api/inngest`, and production ingestion/trigger execution.
- **Local path**: training, backtests, heavy scripts, dataset builds, options pulls, and other research workloads stay local.
- **Current guardrail**: do not treat the parked local-first-for-everything / Prisma-containment detour as active architecture.
- **Recent fix**: commit `a966731` restored the deployed `/api/inngest` endpoint after the temporary cloud kill switch in `121dab8`.

## Current Phase

- Pre-Phase-1 governance/spec/hardening closeout.
- Near-term engineering sequence: MACD production correction, then volume production correction, then remaining trigger hardening.
- Preserve valid trigger-engine work and new symbols needed for the trigger decision engine and Warbird. Remove only sidetrack work.

## System Overview

Rabid Raccoon is a futures trading intelligence platform. It answers one question: **"What is MES likely to do, and why?"**

To answer that, it:

1. **Ingests** market prices, economic indicators, macro reports, news signals, and calendar events from external sources (Databento, FRED, RSS feeds, Yahoo).
2. **Stores** everything in a normalized PostgreSQL database accessed via Prisma.
3. **Trains** predictive models using engineered features derived from that data.
4. **Analyzes** real-time market conditions using both deterministic rules and AI.
5. **Displays** analysis, forecasts, BHG setups, and correlation data on a Next.js dashboard.
6. **(Phase 2)** Pushes predictions to TradingView via webhook for chart overlay.

## Data Flow

```
                    ┌─────────────────────────────────────────┐
                    │           EXTERNAL SOURCES               │
                    │  Databento · FRED · Yahoo · RSS · News   │
                    └──────────────────┬──────────────────────┘
                                       │
                          ┌────────────▼────────────┐
                          │     INGESTION LAYER      │
                          │  scripts/ingest-*.ts     │
                          │  src/inngest/functions/  │
                          │  src/lib/ingest/         │
                          └────────────┬────────────┘
                                       │ writes
                          ┌────────────▼────────────┐
                          │       POSTGRESQL         │
                          │    (via Prisma ORM)      │
                          │                          │
                          │  Market: mkt_futures_*   │
                          │  Econ:   econ_*_1d       │
                          │  News:   econ_news_1d    │
                          │          policy_news_1d  │
                          │          news_signals    │
                          │  Macro:  macro_reports_1d│
                          │          econ_calendar   │
                          │  Signal: bhg_setups      │
                          │          measured_move_*  │
                          │  Meta:   symbols         │
                          │          economic_series  │
                          │          symbol_mappings  │
                          │          data_source_*    │
                          │          ingestion_runs   │
                          │  Model:  mes_model_*     │
                          └──┬───────────┬──────────┘
                             │           │
                    reads    │           │  reads
              ┌──────────────▼──┐   ┌───▼──────────────────┐
              │   DASHBOARD      │   │   TRAINING MODELS     │
              │   (Next.js)      │   │   scripts/build-*.ts  │
              │                  │   │   models/              │
              │  /api/analyse/*  │   │   datasets/            │
              │  /api/forecast   │   │                        │
              │  /api/live/*     │   │  Reads raw data,       │
              │  /api/market-*   │   │  engineers features,   │
              │  /api/mes/*      │   │  trains models,        │
              │  /api/news/*     │   │  writes to registry    │
              │                  │   │                        │
              │  Components:     │   └────────────────────────┘
              │  MarketsGrid     │
              │  ForecastPanel   │
              │  MesIntraday/*   │
              └────────┬────────┘
                       │
                       │ webhook (Phase 2)
              ┌────────▼────────┐
              │  TRADINGVIEW     │
              │  INDICATOR       │
              │  indicators/     │
              │                  │
              │  Receives        │
              │  predictions,    │
              │  draws on chart. │
              │  No storage.     │
              └─────────────────┘
```

## Execution Boundaries

- **Cloud runtime** owns lightweight runtime reads, the deployed Inngest endpoint, and production trigger/ingestion execution.
- **Local execution** owns heavy ingest/backfill utilities, dataset builders, training runs, backtests, and diagnostics that do not belong in the cloud request path.
- **Shared DB truth** lives in Postgres and the Prisma schema, but heavy local workflows should not be confused with the active runtime architecture.

## Database Architecture

### Design Principles

1. **Domain-first table naming**: Tables are prefixed by domain (`mkt_`, `econ_`, `macro_`, `bhg_`, `mes_model_`).
2. **Timeframe suffix**: `_1d`, `_1h`, `_15m` indicate the granularity of the data.
3. **MES isolation**: MES has dedicated tables (`mkt_futures_mes_1h`, `mkt_futures_mes_15m`, `mkt_futures_mes_1d`) because it is the primary instrument with unique ingestion cadence and granularity requirements. Non-MES futures share generic tables with `symbolCode` FK.
4. **Econ domain splitting**: Economic data is split by category (`econ_rates_1d`, `econ_yields_1d`, `econ_fx_1d`, etc.) mirroring the ZINC Fusion V15 pattern. All split tables FK to `economic_series`.
5. **Idempotent ingestion**: Every data table has a natural unique constraint and supports `skipDuplicates` or upsert patterns.

### Table Groups

#### Market Data (`mkt_*`)

| Table                 | Key                              | Granularity | Notes                                    |
| --------------------- | -------------------------------- | ----------- | ---------------------------------------- |
| `mkt_futures_mes_15m` | `eventTime` unique               | 15-min      | MES intraday — primary trading timeframe |
| `mkt_futures_mes_1h`  | `eventTime` unique               | Hourly      | MES hourly candles                       |
| `mkt_futures_mes_1d`  | `eventDate` unique               | Daily       | MES daily candles                        |
| `mkt_futures_1h`      | `(symbolCode, eventTime)` unique | Hourly      | Non-MES futures, FK to symbols           |
| `mkt_futures_1d`      | `(symbolCode, eventDate)` unique | Daily       | Non-MES futures, FK to symbols           |

Check constraints: `mkt_futures_1h` and `mkt_futures_1d` have DB-level check constraints preventing `symbolCode = 'MES'` to enforce MES isolation.

#### Economic Data (`econ_*`)

All econ domain tables share identical structure: `(seriesId, eventDate)` unique, FK to `economic_series`.

| Table                 | Category    | Source |
| --------------------- | ----------- | ------ |
| `econ_rates_1d`       | RATES       | FRED   |
| `econ_yields_1d`      | YIELDS      | FRED   |
| `econ_fx_1d`          | FX          | FRED   |
| `econ_vol_indices_1d` | VOLATILITY  | FRED   |
| `econ_inflation_1d`   | INFLATION   | FRED   |
| `econ_labor_1d`       | LABOR       | FRED   |
| `econ_activity_1d`    | ACTIVITY    | FRED   |
| `econ_money_1d`       | MONEY       | FRED   |
| `econ_commodities_1d` | COMMODITIES | FRED   |
| `econ_indexes_1d`     | EQUITY      | FRED   |

#### News & Macro

| Table              | Key                              | Purpose                        |
| ------------------ | -------------------------------- | ------------------------------ |
| `econ_news_1d`     | `rowHash` unique                 | Economic news articles         |
| `policy_news_1d`   | `rowHash` unique                 | Policy/political news          |
| `macro_reports_1d` | `(reportCode, eventDate)` unique | Macro economic report releases |
| `econ_calendar`    | `(eventDate, eventName)` unique  | Economic event calendar        |
| `news_signals`     | `link` unique                    | RSS-sourced news signals       |

#### Signals & Models

| Table                   | Key                                                    | Purpose                                          |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `bhg_setups`            | `setupId` unique                                       | Break-Hook-Go trade setups with outcome tracking |
| `measured_move_signals` | `(symbolCode, timeframe, timestamp, direction)` unique | Measured move pattern detection                  |
| `mes_model_registry`    | `(modelName, version)` unique                          | Trained model metadata and metrics               |

#### Reference & Meta

| Table                  | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `symbols`              | Canonical symbol identity (code, display name, tick size, data source) |
| `symbol_mappings`      | Maps symbols to provider-specific identifiers                          |
| `economic_series`      | Canonical economic series identity (FRED series, category, frequency)  |
| `data_source_registry` | Tracks all data sources, their target tables, and ingestion scripts    |
| `ingestion_runs`       | Audit log for every ingestion execution                                |

## Ingestion Architecture

### Data Sources

| Source         | Provider           | What It Feeds                                                             | Ingestion Path                                                              |
| -------------- | ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Databento      | REST API           | MES candles (15m, 1h, 1d), non-MES futures                                | `ingest-market-prices.ts`, `ingest-market-prices-daily.ts`, `backfill-*.ts` |
| Databento      | Python SDK (batch) | Options statistics (OI, volume, IV, delta, settlement) for 15 CME parents | `pull-options-statistics.py`, `pull-options-ohlcv.py`                       |
| FRED           | REST API           | All `econ_*_1d` tables via `economic_series`                              | `ingest-fred-complete.ts`, `ingest-macro-indicators.ts`                     |
| Yahoo          | REST API           | Supplemental market data                                                  | `ingest-macro-indicators.ts`                                                |
| Google News    | RSS                | `news_signals`                                                            | `src/lib/news-scrape.ts`                                                    |
| Alt News Feeds | RSS/API            | `econ_news_1d`, `policy_news_1d`, `macro_reports_1d`                      | `ingest-alt-news-feeds.ts`                                                  |

### Execution Model

Ingestion runs two ways:

1. **Inngest scheduled functions** (`src/inngest/functions/`) — production cadence. Each function is a thin wrapper that calls a shared ingestion library function.
2. **CLI scripts** (`scripts/ingest-*.ts`, `scripts/backfill-*.ts`) — manual/operator runs for backfill, debugging, and initial load.

Both paths write `ingestion_runs` records for audit.

### MES Ingestion Flow (Primary Instrument)

```
Databento API
    │
    ▼
ingest-market-prices-daily.ts (or Inngest mkt-mes-1h)
    │
    ├── MES 1h candles → mkt_futures_mes_1h
    ├── MES 15m candles → mkt_futures_mes_15m (via mes15m-refresh)
    └── MES 1d candles → mkt_futures_mes_1d
```

### Non-MES Ingestion Flow

```
Databento API
    │
    ▼
ingest-market-prices-daily.ts (or Inngest mkt-equity-indices, mkt-treasuries, etc.)
    │
    ├── Hourly candles → mkt_futures_1h (symbolCode FK)
    └── Daily candles → mkt_futures_1d (symbolCode FK)
```

### Options Data Ingestion Flow

Options data is pulled via the **Databento Python SDK** (not the TypeScript REST wrapper) because the data volume is too large for streaming. Uses `batch.submit_job()` for server-side processing.

**15 CME option parents** (indices, metals, energy, treasuries, FX):
`ES.OPT` · `NQ.OPT` · `OG.OPT` · `SO.OPT` · `LO.OPT` · `OKE.OPT` · `ON.OPT` · `OH.OPT` · `OB.OPT` · `HXE.OPT` · `OZN.OPT` · `OZB.OPT` · `OZF.OPT` · `EUU.OPT` · `JPU.OPT`

Agriculture excluded (OZL, OZS, OZM, OZC, OZW) — Kirk decision 2026-02-25.

```
Databento Python SDK (batch or streaming with path=)
    │
    ▼
pull-options-statistics.py
    │
    ├── statistics schema → filter stat_types 3,6,9,14,15
    │   (settlement price, cleared volume, OI, implied vol, delta)
    └── Save monthly parquet → datasets/options-statistics/<SYMBOL>/

pull-options-ohlcv.py
    │
    └── ohlcv-1d schema → datasets/options-ohlcv/<SYMBOL>/
```

**IMPORTANT**: `stype_in='parent'` for ES.OPT returns ~288K stat rows/day (~3,000 active contracts). Use batch jobs or weekly chunks for ES/NQ. Monthly chunks work for smaller symbols.

Definition files (contract specs, strikes, expirations) already on disk: `/Volumes/Satechi Hub/Databento Data Dump/Options/definitions/` (2010–2026).

### Economic Data Ingestion Flow

```
FRED API
    │
    ▼
ingest-fred-complete.ts (or Inngest econ-rates, econ-yields, etc.)
    │
    ├── Upsert economic_series record
    └── Route to correct split table by category:
        ├── RATES → econ_rates_1d
        ├── YIELDS → econ_yields_1d
        ├── FX → econ_fx_1d
        └── ... (one table per EconCategory)
```

## API Architecture

All API routes live under `src/app/api/` following Next.js App Router conventions.

### Read-Only Routes (Dashboard)

| Route                        | Method | Purpose                     |
| ---------------------------- | ------ | --------------------------- |
| `/api/analyse`               | POST   | Full multi-symbol analysis  |
| `/api/analyse/ai`            | POST   | AI-enhanced analysis        |
| `/api/analyse/chart`         | POST   | Chart data for MES 15m      |
| `/api/analyse/deterministic` | POST   | Rule-based analysis         |
| `/api/analyse/market`        | POST   | Market condition assessment |
| `/api/analyse/trades`        | POST   | Trade signal analysis       |
| `/api/forecast`              | GET    | Multi-symbol forecast       |
| `/api/market-data`           | POST   | Single-symbol candle data   |
| `/api/market-data/batch`     | GET    | All-symbol candle data      |
| `/api/mes/correlation`       | GET    | MES correlation scores      |
| `/api/mes/setups`            | GET    | Active BHG setups           |
| `/api/mes/setups/history`    | GET    | Historical BHG setups       |

### Read-Write Routes (Ingestion + Live)

| Route                       | Method       | Purpose                         |
| --------------------------- | ------------ | ------------------------------- |
| `/api/ingest/econ-calendar` | GET          | Trigger econ calendar ingestion |
| `/api/live/mes`             | GET (SSE)    | Live MES data stream            |
| `/api/live/mes15m`          | GET (SSE)    | Live MES 15m data stream        |
| `/api/news/scrape`          | GET          | Trigger news scrape             |
| `/api/news/scrape-reports`  | GET          | Trigger news report scrape      |
| `/api/inngest`              | GET/POST/PUT | Inngest webhook handler         |

## Analysis Pipeline

When the dashboard loads or a user triggers analysis:

1. **Fetch candles** — `fetch-candles.ts` loads OHLCV data for all symbols from the database, with MES getting special handling (15m + 1h granularity).
2. **Build market context** — `market-context.ts` computes cross-asset correlations, regime detection, and intermarket signals.
3. **Generate signals** — `signals.ts` runs deterministic rules (MES vs NQ divergence, VIX bias, treasury impulse, etc.).
4. **Run analysis** — `analyse-data.ts` / `instant-analysis.ts` combines signals with candle data for a full picture.
5. **Produce forecast** — `forecast.ts` generates directional forecasts per symbol with confidence scores.

The pipeline is **read-only** — it never writes back to the database.

## Key Design Decisions (and Why)

### Why MES Has Isolated Tables

MES is the primary trading instrument. It needs 15-minute granularity, sub-hourly live streaming, and the highest data priority. Sharing a table with other futures would mean every MES query needs a `WHERE symbolCode = 'MES'` filter, the index would be less efficient, and the ingestion cadence would be coupled. Isolation keeps MES fast and independent.

### Why Econ Tables Are Split by Category

This mirrors the ZINC Fusion V15 pattern Kirk established. Each category has different update frequencies, sources, and query patterns. Splitting lets each domain evolve independently and keeps queries targeted. The alternative (one big `econ_observations_1d` table) was tried and reverted because it created query complexity and category-mixing bugs.

### Why the Symbol Registry Exists

The codebase accumulated 211 hardcoded symbol references across 30+ files because there was no single source of truth. The registry centralizes symbol identity and group membership so features query roles instead of maintaining their own lists. See AGENTS.md for registry rules.

### Why Prisma Over Raw SQL

Prisma provides type-safe database access, automatic migration management, and a schema-as-code that serves as living documentation. The tradeoff is less control over advanced PostgreSQL features (check constraints are added via raw SQL in migrations and Prisma warns about but doesn't model them).

## WARBIRD Model Architecture

WARBIRD replaces the deprecated core_forecaster v2.1. It is a regression-based MES price prediction system.

### Model Structure

- **ONE unified model per horizon/target** — MES is the only prediction target
- **12 models total**: 3 targets (price, MAE, MFE) × 4 horizons (1h, 4h, 1d, 1w)
- All other symbols, FRED data, news, GPR, Trump Effect, econ tables = **input features**
- No separate per-symbol models. Cross-asset data tells the model what regime MES is in.

### Dataset Structure

One flat CSV per horizon. One row per timestamp. All data sources as columns:

```
timestamp | MES OHLCV+technicals | 63 symbols (OHLCV+velocity) | 31 FRED series | 10 econ tables | news signals | GPR index | Trump Effect | calendar proximity | options data | target_price | target_mae | target_mfe
```

- **Feature count**: 400-600+ columns (not ~148)
- **Everything in the DB goes in** — no pre-filtering. IC ranking + cluster dedup prunes per fold.
- **Feature priority**: macro baselines (yields, rates, gold, credit, VIX) + reaction features (news shocks, vol spikes, policy actions, cross-asset intraday velocity)

### Training Pipeline

```
build-lean-dataset.ts (or build-warbird-dataset.ts)
    │ loads ALL DB tables → engineers features → writes CSV
    ▼
train-warbird.py
    │ AutoGluon TabularPredictor
    │ best_quality, 5 folds, 2 stack levels
    │ Walk-forward CV with purge/embargo
    │ Per-fold IC ranking + cluster dedup → top 30 features
    ▼
models/warbird/{horizon}/
    │ Trained model artifacts
    ▼
predict.py / warbird-signal.ts
    │ Live inference → target zones + risk gates
    ▼
/api/forecast → Dashboard
```

### AutoGluon Settings

| Setting | Value | Rationale |
|---------|-------|-----------|
| `presets` | `best_quality` | Safe for 12GB free RAM |
| `num_bag_folds` | 5 | Max allowed (not 8) |
| `num_stack_levels` | 2 | Kirk: more than 1 stack |
| `fold_fitting_strategy` | `sequential_local` | 1 fold at a time, peak RAM 8-10GB |
| `excluded_model_types` | `[]` | ALL types — let AG decide |
| Time limit (price) | 14400s (4h) | Per fold |
| Time limit (MAE/MFE) | 7200s (2h) | Per fold |

### Hardware Constraints

- Mac Mini M4 Pro, 24GB RAM, 12 CPU cores
- CPU-bound, NOT RAM-bound
- Peak RAM: 8-10GB during training
- Strictly sequential: 1 horizon → 1 target → 1 fold
- NEVER run Ollama/local AI during training

### Signal Pipeline (Post-Training)

1. **GJR-GARCH(1,1)** — conditional volatility estimation, 5 vol states
2. **Monte Carlo** — 10K paths, war-regime-aware tail behavior
3. **Target Zones** — Fibonacci-anchored horizontal price levels
4. **Risk Gates** — 1% risk per trade, war regime position caps
5. **War Regime Classifier** — geopolitical risk overlay

## Environment & Infrastructure

| Component        | Detail                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Database         | PostgreSQL via Prisma (`DIRECT_URL` / `LOCAL_DATABASE_URL` direct by default; Accelerate only with `USE_ACCELERATE=1` + `DATABASE_URL`) |
| Direct DB access | `DIRECT_URL` (or `LOCAL_DATABASE_URL` fallback) is the normal direct path for runtime and migrations |
| Hosting          | Vercel (dashboard)                                                          |
| Scheduling       | Inngest (managed, event-driven)                                             |
| Market data      | Databento (REST, requires `DATABENTO_API_KEY`)                              |
| Economic data    | FRED (REST, requires `FRED_API_KEY`)                                        |
| Development      | Mac Mini (primary), MacBook Air (secondary), Satechi Hub external drive     |

---

_Last updated: 2026-02-22_
_Maintained by: Kirk (architect) with Claude (governance)_
