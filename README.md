# Rabid Raccoon 🦝
### A Multi-Feature Pine Script v6 Trading Indicator

**Author:** Kirk / ZINC Digital  
**Pine Script Version:** v6  
**Primary Use:** MES (Micro E-mini S&P 500) Futures

---

## Features

| Module | Status | Description |
|--------|--------|-------------|
| Measured Move Detection | 🔲 TODO | Equal-length price swing identification with projected targets |
| Auto-Fibonacci Engine | 🔲 TODO | Multi-timeframe fib methodology (4H → 1H → 15m) |
| Break-Hook-Go | 🔲 TODO | Structure break → retest → continuation pattern detection |
| Correlation Analysis | 🔲 TODO | Dynamic VIX/DXY/NQ correlation with divergence signals |
| Risk Management | 🔲 TODO | Position sizing, stop placement, R:R calculation |

## Project Structure

```
rabid-raccoon/
├── indicators/          # Main indicator scripts
│   └── rabid-raccoon.pine
├── strategies/          # Strategy (backtesting) versions
├── libraries/           # Publishable Pine Script libraries
├── docs/                # Documentation, methodology notes
├── templates/           # Reusable code templates
└── README.md
```

## Development Workflow

1. **Edit** in VS Code (with kaigouthro Pine Script extension for real-time linting)
2. **Validate** — extension catches errors via TradingView's pine-facade API
3. **Copy-paste** into TradingView Pine Editor → "Add to Chart"
4. **Debug** using Pine Logs, Pine Profiler, debug dashboard (toggle Debug Mode input)
5. **Iterate** — paste errors back, fix, commit, re-paste

## VS Code Extensions

- `kaigouthro.pinescript-vscode` — Primary: real-time linting, v6 support, autocompletion
- `usernamehw.errorlens` — Inline error display
- `eamodio.gitlens` — Git history and blame

## Architecture Notes

- Single indicator file with `//#region` blocks for modularity
- Each feature has a toggle input for isolation/debugging
- Shared swing detection core feeds multiple modules
- UDTs for structured data (MeasuredMove, FibLevel, RiskProfile, etc.)
- v6 dynamic requests enable loop-based correlation analysis
- Debug mode activates status dashboard + log output

## Web App AI Analysis Setup

For the Next.js dashboard analysis overlay (`/api/analyse/ai`), set:

- `OPENAI_API_KEY`
- `OPENAI_ANALYSIS_MODEL` (default fallback chain in code starts with `gpt-5.2-pro`)
- `OPENAI_FORECAST_MODEL` (optional; defaults to `OPENAI_ANALYSIS_MODEL`)

Copy `.env.example` to `.env.local` and fill the keys.

## Prisma Data Layer (Local PostgreSQL)

The app now supports persistent market/macro storage via Prisma + Postgres.

### 1. Start local DB

```bash
npm run db:up
```

Default local URL:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public
```

### 2. Apply schema

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npx prisma migrate dev --name init_market_data
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npx prisma generate
```

### 3. Machine-Only Initial Backfill (no synthetic data)

Backfill is intentionally a local machine operation. Runtime API fallback pulls are disabled.

`ingest:market` is hard-locked to:
- `33` symbols
- `730` days
- `1h` prices aggregated from Databento `1m`
- Databento-only + zero-fake policy
- no runtime overrides (except `--dry-run`)

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npm run ingest:market
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npm run ingest:macro -- --days-back 730
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npm run ingest:mm -- --timeframe 1h --days-back 120
```

### 4. Daily Automation (Inngest)

The route `api/inngest` defines the daily scheduled pipeline:
- incremental Databento update for 1h prices (`market-prices-1h-daily`)
- macro refresh (FRED + Yahoo FXI)
- measured-move refresh from stored prices

Local dev:

```bash
npm run dev
npm run inngest:dev
```

Production:
- deploy with `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY`
- connect your Inngest app to `https://<your-domain>/api/inngest`

### 5. Live MES Stream (Databento -> DB -> Lightweight Charts)

`mes_prices_1m` stores streaming minute data for chart updates.

Run the local worker:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npm run ingest:mes:live
```

Smoke once:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npm run ingest:mes:live -- --once=true --lookback-minutes 240
```

Dashboard live endpoint:
- `GET /api/live/mes` (SSE snapshot + updates)

### 6. Validate row counts

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rabid_raccoon?schema=public npm run db:counts
```

### 7. Stop local DB

```bash
npm run db:down
```

## MES HFT Halsey Module

Standalone Python intraday module (Databento + FRED + Yahoo only, no Polygon):

- Path: `mes_hft_halsey/`
- Scanner: `mes_hft_halsey/mes_intraday_halsey.py`
- Optional API: `mes_hft_halsey/mes_api.py`
- Docs: `mes_hft_halsey/README.md`

Quick start:

```bash
pip install -r mes_hft_halsey/requirements.txt
python mes_hft_halsey/mes_intraday_halsey.py --days-back 90 --swing-order 5 --min-rr 2.0
```
