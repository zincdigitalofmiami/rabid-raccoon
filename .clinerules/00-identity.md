# Project: Rabid Raccoon

- TypeScript/Next.js application with Prisma ORM
- Prisma Accelerate for connection pooling (DATABASE_URL ≠ DIRECT_URL is NORMAL)
- Inngest for serverless function orchestration
- FRED API for economic data ingestion
- Symbol registry pattern: symbols have roles (INGESTION_ACTIVE, etc.)
- Data tables: mkt*futures*_, econ\__, news_signals, bhg_setups, measured_move_signals

# Architecture Conventions

- AGENTS.md is the source of truth for coding standards
- No hardcoded symbol arrays — always query the registry
- All Inngest functions must create IngestionRun records
- All Inngest functions must have try/catch with error logging
