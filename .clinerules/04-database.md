# Database Context

## Architecture

- Prisma Accelerate dual-URL pattern
- DATABASE_URL = Accelerate proxy (pooled, for app reads)
- DIRECT_URL = Direct Postgres (for migrations, batch writes)
- Different tenant IDs / user IDs is NORMAL, not a bug

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
