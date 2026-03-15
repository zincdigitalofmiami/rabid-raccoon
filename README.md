# Rabid Raccoon

Rabid Raccoon is a MES futures trading intelligence platform. It combines production ingestion and trigger execution in a Next.js/Inngest cloud runtime with local training, backtesting, dataset building, and research workflows.

If you are an AI agent, read [AGENTS.md](AGENTS.md) first. System/runtime design references live in [docs/plans/2026-03-14-warbird-canonical-teardown-spec.md](docs/plans/2026-03-14-warbird-canonical-teardown-spec.md) and [docs/plans/2026-03-09-runtime-data-flow-audit.md](docs/plans/2026-03-09-runtime-data-flow-audit.md). Coding standards live in [CONVENTIONS.md](CONVENTIONS.md).

## Current Operating Model

- Cloud DB + cloud runtime are the active production path for the app, deployed triggers, and production ingestion.
- The local machine owns training, backtests, heavy scripts, dataset builds, options pulls, and other research-scale jobs.
- The temporary `/api/inngest` cloud kill switch introduced in `121dab8` was reversed on 2026-03-08 by commit `a966731`.
- The local-first-for-everything / Prisma-containment detour is parked history, not the current phase path.

## Current Phase

- Pre-Phase-1 governance/spec/hardening closeout.
- Trigger-engine work and the new symbols needed for both the trigger decision engine and Warbird are active keep-path work.
- Sidetrack cleanup should remove only off-path detours, not valid trigger or symbol work.
- Near-term engineering order is MACD production correction, then volume production correction, then remaining trigger hardening.

## Repository Domains

### Dashboard

- Path: `src/app/`, `src/components/`, `src/lib/`
- Purpose: runtime reads, analysis views, live endpoints, and production-trigger surfaces

### Training / Warbird

- Path: `scripts/build-*.ts`, `models/`, `datasets/`, `strategies/`, `libraries/`, `measured-move/`, `mes_hft_halsey/`
- Purpose: datasets, feature engineering, model training, backtests, and research

### TradingView Indicator (Phase 2)

- Path: `indicators/`
- Purpose: Pine Script/chart overlay work only after Phase 2 approval

## Key Paths

- `src/app/api/inngest/route.ts`: deployed Inngest endpoint
- `src/inngest/`: scheduled jobs and trigger execution
- `src/lib/symbol-registry/`: authoritative symbol registry
- `prisma/schema.prisma`: schema source of truth
- `docs/handoffs/`: governance and handoff checkpoints

## Useful Commands

```bash
npm run dev
npm run inngest:dev
npx tsc --noEmit --pretty false
npm run build
```

## Documentation Map

- [AGENTS.md](AGENTS.md): agent governance and workflow rules
- [docs/plans/2026-03-14-warbird-canonical-teardown-spec.md](docs/plans/2026-03-14-warbird-canonical-teardown-spec.md): canonical Warbird architecture and teardown target
- [docs/plans/2026-03-09-runtime-data-flow-audit.md](docs/plans/2026-03-09-runtime-data-flow-audit.md): verified runtime/data-flow baseline and ingress topology
- [CONVENTIONS.md](CONVENTIONS.md): coding standards
- [docs/plans/2026-03-13-warbird-master-tasklist.md](docs/plans/2026-03-13-warbird-master-tasklist.md): live Warbird execution surface
- [docs/legacy/README.md](docs/legacy/README.md): archived historical docs and superseded plans
