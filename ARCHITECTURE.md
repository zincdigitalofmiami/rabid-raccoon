# ARCHITECTURE.md — Rabid Raccoon System Design

Read AGENTS.md first. This document describes how the system works. AGENTS.md describes how you work on the system.

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

## Database Architecture

### Design Principles

1. **Domain-first table naming**: Tables are prefixed by domain (`mkt_`, `econ_`, `macro_`, `bhg_`, `mes_model_`).
2. **Timeframe suffix**: `_1d`, `_1h`, `_15m` indicate the granularity of the data.
3. **MES isolation**: MES has dedicated tables (`mkt_futures_mes_1h`, `mkt_futures_mes_15m`, `mkt_futures_mes_1d`) because it is the primary instrument with unique ingestion cadence and granularity requirements. Non-MES futures share generic tables with `symbolCode` FK.
4. **Econ domain splitting**: Economic data is split by category (`econ_rates_1d`, `econ_yields_1d`, `econ_fx_1d`, etc.) mirroring the ZINC Fusion V15 pattern. All split tables FK to `economic_series`.
5. **Idempotent ingestion**: Every data table has a natural unique constraint and supports `skipDuplicates` or upsert patterns.

### Table Groups

#### Market Data (`mkt_*`)

| Table | Key | Granularity | Notes |
|-------|-----|-------------|-------|
| `mkt_futures_mes_15m` | `eventTime` unique | 15-min | MES intraday — primary trading timeframe |
| `mkt_futures_mes_1h` | `eventTime` unique | Hourly | MES hourly candles |
| `mkt_futures_mes_1d` | `eventDate` unique | Daily | MES daily candles |
| `mkt_futures_1h` | `(symbolCode, eventTime)` unique | Hourly | Non-MES futures, FK to symbols |
| `mkt_futures_1d` | `(symbolCode, eventDate)` unique | Daily | Non-MES futures, FK to symbols |

Check constraints: `mkt_futures_1h` and `mkt_futures_1d` have DB-level check constraints preventing `symbolCode = 'MES'` to enforce MES isolation.

#### Economic Data (`econ_*`)

All econ domain tables share identical structure: `(seriesId, eventDate)` unique, FK to `economic_series`.

| Table | Category | Source |
|-------|----------|--------|
| `econ_rates_1d` | RATES | FRED |
| `econ_yields_1d` | YIELDS | FRED |
| `econ_fx_1d` | FX | FRED |
| `econ_vol_indices_1d` | VOLATILITY | FRED |
| `econ_inflation_1d` | INFLATION | FRED |
| `econ_labor_1d` | LABOR | FRED |
| `econ_activity_1d` | ACTIVITY | FRED |
| `econ_money_1d` | MONEY | FRED |
| `econ_commodities_1d` | COMMODITIES | FRED |
| `econ_indexes_1d` | EQUITY | FRED |

#### News & Macro

| Table | Key | Purpose |
|-------|-----|---------|
| `econ_news_1d` | `rowHash` unique | Economic news articles |
| `policy_news_1d` | `rowHash` unique | Policy/political news |
| `macro_reports_1d` | `(reportCode, eventDate)` unique | Macro economic report releases |
| `econ_calendar` | `(eventDate, eventName)` unique | Economic event calendar |
| `news_signals` | `link` unique | RSS-sourced news signals |

#### Signals & Models

| Table | Key | Purpose |
|-------|-----|---------|
| `bhg_setups` | `setupId` unique | Break-Hook-Go trade setups with outcome tracking |
| `measured_move_signals` | `(symbolCode, timeframe, timestamp, direction)` unique | Measured move pattern detection |
| `mes_model_registry` | `(modelName, version)` unique | Trained model metadata and metrics |

#### Reference & Meta

| Table | Purpose |
|-------|---------|
| `symbols` | Canonical symbol identity (code, display name, tick size, data source) |
| `symbol_mappings` | Maps symbols to provider-specific identifiers |
| `economic_series` | Canonical economic series identity (FRED series, category, frequency) |
| `data_source_registry` | Tracks all data sources, their target tables, and ingestion scripts |
| `ingestion_runs` | Audit log for every ingestion execution |

## Ingestion Architecture

### Data Sources

| Source | Provider | What It Feeds | Ingestion Path |
|--------|----------|---------------|----------------|
| Databento | REST API | MES candles (15m, 1h, 1d), non-MES futures | `ingest-market-prices.ts`, `ingest-market-prices-daily.ts`, `backfill-*.ts` |
| Databento | Python SDK (batch) | Options statistics (OI, volume, IV, delta, settlement) for 15 CME parents | `pull-options-statistics.py`, `pull-options-ohlcv.py` |
| FRED | REST API | All `econ_*_1d` tables via `economic_series` | `ingest-fred-complete.ts`, `ingest-macro-indicators.ts` |
| Yahoo | REST API | Supplemental market data | `ingest-macro-indicators.ts` |
| Google News | RSS | `news_signals` | `src/lib/news-scrape.ts` |
| Alt News Feeds | RSS/API | `econ_news_1d`, `policy_news_1d`, `macro_reports_1d` | `ingest-alt-news-feeds.ts` |

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

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/analyse` | POST | Full multi-symbol analysis |
| `/api/analyse/ai` | POST | AI-enhanced analysis |
| `/api/analyse/chart` | POST | Chart data for MES 15m |
| `/api/analyse/deterministic` | POST | Rule-based analysis |
| `/api/analyse/market` | POST | Market condition assessment |
| `/api/analyse/trades` | POST | Trade signal analysis |
| `/api/forecast` | GET | Multi-symbol forecast |
| `/api/market-data` | POST | Single-symbol candle data |
| `/api/market-data/batch` | GET | All-symbol candle data |
| `/api/mes/correlation` | GET | MES correlation scores |
| `/api/mes/setups` | GET | Active BHG setups |
| `/api/mes/setups/history` | GET | Historical BHG setups |

### Read-Write Routes (Ingestion + Live)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/ingest/econ-calendar` | GET | Trigger econ calendar ingestion |
| `/api/live/mes` | GET (SSE) | Live MES data stream |
| `/api/live/mes15m` | GET (SSE) | Live MES 15m data stream |
| `/api/news/scrape` | GET | Trigger news scrape |
| `/api/news/scrape-reports` | GET | Trigger news report scrape |
| `/api/inngest` | GET/POST/PUT | Inngest webhook handler |

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

## Environment & Infrastructure

| Component | Detail |
|-----------|--------|
| Database | PostgreSQL via Prisma Accelerate (`prisma+postgres://`) |
| Direct DB access | Requires `DIRECT_URL` (direct `postgres://` string) for migrations and direct pg workloads |
| Hosting | Vercel (dashboard) |
| Scheduling | Inngest (managed, event-driven) |
| Market data | Databento (REST, requires `DATABENTO_API_KEY`) |
| Economic data | FRED (REST, requires `FRED_API_KEY`) |
| Development | Mac Mini (primary), MacBook Air (secondary), Satechi Hub external drive |

---

*Last updated: 2026-02-22*
*Maintained by: Kirk (architect) with Claude (governance)*
