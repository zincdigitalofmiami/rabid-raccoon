# Agent Handoff: DB Routing + Migration Learnings (2026-02-27)

## Purpose

Persist high-signal lessons from PR #7 work so future agents do not reintroduce DB routing drift.

## Confirmed Routing Contract

1. `LOCAL_DATABASE_URL`: local-first development target.
2. `DATABASE_URL`: deployed Prisma runtime target (typically Accelerate URL).
3. `DIRECT_URL`: direct Postgres target for migrations/direct operations.
4. `PRISMA_LOCAL=1` and `PRISMA_DIRECT=1` are explicit override flags; never set both.

## Confirmed Anti-Pattern

Do **not** run commands with env remapping like:

```bash
DATABASE_URL="$DIRECT_URL" npx tsx ...
```

Reason:

1. It hides intent.
2. It makes telemetry and error triage ambiguous.
3. It bypasses the explicit routing contract.

Preferred:

```bash
PRISMA_DIRECT=1 npx tsx scripts/db-counts.ts
PRISMA_DIRECT=1 npx prisma migrate status
PRISMA_DIRECT=1 npx prisma migrate deploy
```

## Roadblocks Seen in Practice

1. Direct DB was behind by one migration (`20260227153000_add_mes_4h_1w_tables`), causing missing-table failures.
2. Local DB was schema-valid but empty, causing local/dev results to diverge from direct.
3. Strict backfill for `4h/1w` cannot run without `DATABENTO_API_KEY`; this must be preflighted.

## Mandatory Preflight Before Any Backfill/Migration

1. Verify target host (`LOCAL_DATABASE_URL` vs `DIRECT_URL`) before writes.
2. Run `npx prisma migrate status` and `PRISMA_DIRECT=1 npx prisma migrate status`.
3. Confirm provider keys (`DATABENTO_API_KEY`, others) are present.
4. Use structured `[db-target]` logs as hard gate before continuing.

## Operational Guardrails

1. Migration first, then data backfill/derive, then training smoke.
2. For partial failures, require machine-readable manifest and targeted retry path.
3. Keep local data parity with direct when local-first development is expected.

