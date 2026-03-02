# Database Context

## Architecture

- Prisma three-URL pattern (LOCAL_DATABASE_URL added for local dev)
- DATABASE_URL = Accelerate proxy (`prisma+postgres://`) — Vercel production runtime
- DIRECT_URL = Direct Postgres — Prisma CLI override + production batch writes
- LOCAL_DATABASE_URL = Local Postgres — `next dev`, local batch scripts, Prisma CLI (default)
- Different tenant IDs / user IDs is NORMAL, not a bug
- `prisma.config.ts` resolves CLI URL: LOCAL_DATABASE_URL → DIRECT_URL → DATABASE_URL (non-throwing, falls back gracefully during `prisma generate`)
- `prisma/schema.prisma` has `url = env("DATABASE_URL")` for tooling compatibility (Studio, db pull, schema linting)

## Symbol Registry

- symbols table with role assignments via symbol_role_members
- INGESTION_ACTIVE role = symbols that should be ingested on cron
- Current INGESTION_ACTIVE (16): ES, MES, NQ, YM, RTY, SOX, ZN, ZB, ZF, CL, GC, SI, NG, 6E, 6J, SR3
- Known missing from role: MNQ, MYM, ZT, SR1, ZQ (causes silent step failures)

## Table Categories

- mkt*futures*\* = market price data (CME/exchange sourced)
- econ\_\* = FRED economic data (various publication frequencies)
- news_signals = AI-processed news signals (multiple layers)
- bhg_setups = BHG trading setups (no scheduled generation)
- measured_move_signals = measured move pattern detection
- ingestion_runs = job tracking (currently only market-prices-futures-daily writes here)
