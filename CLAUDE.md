# CLAUDE.md — Rabid Raccoon

This is an MES futures trading intelligence platform built with Next.js, Prisma, Inngest, Databento, and AutoGluon.

## Current Project State (Feb 20, 2026)

See `docs/PROJECT-ROADMAP.md` for the full architecture, goals, and implementation phases.

**Active work:**
- ML directional model: Phase 1 classification training (binary up/down, walk-forward validation, ~128 features, 36K rows)
- Next up: Evaluate Phase 1 OOF results → feature importance → Phase 2 production training
- After model: Statistical backtesting engine (indicator signals, pressure map, event reactions — all with sample sizes)
- Then: Command Center dashboard (single-page, everything backed by backtested stats)
- Then: Rabid Raccoon TradingView indicator (Pine Script, pressure map overlay + signal flags)

**Key principle:** Every number shown to Kirk has a verifiable sample size (n=X). No black boxes.

## Architecture

- `src/inngest/` — Background jobs (daily ingestion, backfill)
- `src/lib/` — Core libraries (databento, fibonacci, signals, risk engine)
- `src/app/api/` — API routes (market data, forecasting, analysis)
- `src/components/` — React dashboard components
- `scripts/` — Standalone data scripts

## Critical Rules

1. Inngest client ID must remain `"rabid-raccoon"` — never change it
2. All Inngest side effects must be inside `step.run()` blocks
3. OHLCV data must be validated before insert (open > 0, high >= low, no NaN)
4. Volume fields use BigInt, never Number
5. All createMany calls must include `skipDuplicates: true`
6. Timestamps are UTC — never local timezone
7. Landing tables are append-only — no DELETE, no UPDATE
8. No hardcoded API keys or secrets

## Inngest Sync

After every Vercel deploy, Inngest Cloud may not auto-discover new/changed functions.
Force a re-sync with:

```bash
curl -X PUT "https://rabid-raccoon.vercel.app/api/inngest" -H "Content-Type: application/json" -d '{}'
```

Expected response: `{"message":"Successfully registered","modified":true}`

## Inngest Schedule (19 cron + 1 event-triggered)

All cron jobs run 1 hour apart to prevent concurrency crashes.

| UTC   | EST     | Function ID                  | Category      |
|-------|---------|------------------------------|---------------|
| 00:00 | 7 PM    | ingest-mkt-mes-1h            | Market Data   |
| 01:00 | 8 PM    | ingest-mkt-equity-indices    | Market Data   |
| 02:00 | 9 PM    | ingest-mkt-treasuries        | Market Data   |
| 03:00 | 10 PM   | ingest-mkt-commodities       | Market Data   |
| 04:00 | 11 PM   | ingest-mkt-fx-rates          | Market Data   |
| 05:00 | 12 AM   | ingest-econ-rates            | FRED Econ     |
| 06:00 | 1 AM    | ingest-econ-yields           | FRED Econ     |
| 07:00 | 2 AM    | ingest-econ-vol-indices      | FRED Econ     |
| 08:00 | 3 AM    | ingest-econ-inflation        | FRED Econ     |
| 09:00 | 4 AM    | ingest-econ-fx               | FRED Econ     |
| 10:00 | 5 AM    | ingest-econ-labor            | FRED Econ     |
| 11:00 | 6 AM    | ingest-econ-activity         | FRED Econ     |
| 12:00 | 7 AM    | ingest-econ-commodities      | FRED Econ     |
| 13:00 | 8 AM    | ingest-econ-money            | FRED Econ     |
| 14:00 | 9 AM    | ingest-econ-indexes          | FRED Econ     |
| 15:00 | 10 AM   | ingest-econ-calendar         | Events/News   |
| 16:00 | 11 AM   | ingest-news-signals          | Events/News   |
| 17:00 | 12 PM   | ingest-alt-news              | Events/News   |
| 18:00 | 1 PM    | ingest-measured-moves        | Signals       |
| —     | —       | backfill-mes-all-timeframes  | Backfill (event-triggered) |

## Environment Boundaries

- This project shares a Vercel team with ZINC-FUSION-V15 — they must stay isolated
- Inngest environment keys must NOT be shared between projects
- Never reference V15 env vars (WORKFLOW_INNGEST_SIGNING_KEY, INNGEST_ENV)

## Code Review

Before committing, run `cubic review` to catch bugs and improvements.
Wait 2-3 minutes for the review to complete, then validate the issues found and fix them.

## Completion Gate

Before marking work complete: lint passes, no type errors, and `cubic review` clean.
