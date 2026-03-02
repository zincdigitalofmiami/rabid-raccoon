# Project: Rabid Raccoon

- TypeScript/Next.js application with Prisma ORM
- Three-URL pattern: LOCAL_DATABASE_URL (dev/CLI default) · DIRECT_URL (migrations/CLI override) · DATABASE_URL (Accelerate, Vercel production)
- DATABASE_URL ≠ DIRECT_URL is NORMAL — different protocols/endpoints by design
- `prisma.config.ts` resolves CLI URL with priority LOCAL_DATABASE_URL → DIRECT_URL → DATABASE_URL (non-throwing)
- Inngest for serverless function orchestration
- FRED API for economic data ingestion
- Symbol registry pattern: symbols have roles (INGESTION_ACTIVE, etc.)
- Data tables: mkt*futures*_, econ\__, news_signals, bhg_setups, measured_move_signals

# Architecture Conventions

- AGENTS.md is the source of truth for coding standards
- No hardcoded symbol arrays — always query the registry
- All Inngest functions must create IngestionRun records
- All Inngest functions must have try/catch with error logging
