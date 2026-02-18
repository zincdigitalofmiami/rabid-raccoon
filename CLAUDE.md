# CLAUDE.md — Rabid Raccoon

This is an MES futures trading platform built with Next.js, Prisma, Inngest, and Databento.

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

## Environment Boundaries

- This project shares a Vercel team with ZINC-FUSION-V15 — they must stay isolated
- Inngest environment keys must NOT be shared between projects
- Never reference V15 env vars (WORKFLOW_INNGEST_SIGNING_KEY, INNGEST_ENV)

## Code Review

Before committing, run `cubic review` to catch bugs and improvements.
Wait 2-3 minutes for the review to complete, then validate the issues found and fix them.

## Completion Gate

Before marking work complete: lint passes, no type errors, and `cubic review` clean.
