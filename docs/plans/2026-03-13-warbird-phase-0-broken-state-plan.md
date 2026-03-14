# Warbird Phase 0 Broken-State Plan

**Date:** 2026-03-13
**Status:** Proposed execution plan
**Scope:** Rabid Raccoon project, Warbird model/engine
**Execution mode:** `main` only, one block at a time
**Execution checklist:** [2026-03-13-warbird-master-tasklist.md](./2026-03-13-warbird-master-tasklist.md)

---

## Summary

Rabid Raccoon is the project. Warbird is the model/engine.

The current repo state is split across two competing truths:

1. `main` contains the production recovery note and later deploy tweaks.
2. `warbird/phase-0-rename` contains useful DB/runtime hardening and broad Warbird rename work that never landed on `main`.

Phase 0 is therefore not a rename pass. Phase 0 is a broken-state audit and stabilization pass that gets `main` back to one coherent runtime/database contract before any larger Warbird rollout.

The approved build strategy is:

- build new Warbird engine files beside legacy first
- verify block by block
- archive legacy only after parity and feed stability are proven

---

## Why Phase 0 Exists

The current dashboard/feed breakage is not explained by one bug. It is the result of drift:

- branch drift between `main` and `warbird/phase-0-rename`
- DB/runtime env-role drift (`DATABASE_URL` vs `DIRECT_URL` vs `LOCAL_DATABASE_URL`)
- BHG naming still active on `main`
- partial Warbird work living off-branch
- dashboard feed health depending on the same unstable DB/runtime layer

If this is not stabilized first, every Warbird block built on top of it will inherit the same confusion.

---

## Canonical Rules

1. `main` is the only execution branch.
2. Do not blindly merge `warbird/phase-0-rename`.
3. Do not physically rename DB objects during Phase 0.
4. Do not change the frozen MES chart frontend contract during Phase 0.
5. Do not call a block complete until verification is written down.
6. Treat older BHG/Warbird artifacts as reference material only until reviewed.

---

## Source Precedence

Use these in this order:

1. Current `main` repo state
2. [2026-03-13-prisma-production-recovery.md](./2026-03-13-prisma-production-recovery.md)
3. [2026-03-09-runtime-data-flow-audit.md](./2026-03-09-runtime-data-flow-audit.md)
4. [2026-03-09-trigger-core-contract.md](./2026-03-09-trigger-core-contract.md)
5. [2026-02-23-trade-intelligence-engine-design.md](./2026-02-23-trade-intelligence-engine-design.md) and [2026-02-23-trade-intelligence-engine.md](./2026-02-23-trade-intelligence-engine.md) for engine logic only, not the one-page frontend rewrite
6. Branch-only commits on `warbird/phase-0-rename` as a parts bin, not as merge truth:
   - `ff2cc6c`
   - `138e302`
   - `0f05685`
   - `d858a98`
   - `edc67b4`
   - `26085cd`

Branch-only docs and handover files are useful context, but they are not canonical until their claims are re-verified on `main`.

---

## Phase 0 Findings

### 1. Main and branch do not agree

`main` does not contain the DB/runtime hardening from `ff2cc6c` or the later branch-only rename work.

Implication:

- current `main` still reflects the older DB runtime contract
- branch-only fixes must be reviewed and selectively ported

### 2. The current DB/runtime contract is still split

The runtime and script paths do not all resolve DB URLs the same way on `main`.

Implication:

- some feeds/routes can look healthy locally while still being fragile in deployment
- env drift can recreate the outage pattern documented on 2026-03-13

### 3. The branch-only rename is too broad to trust wholesale

The branch contains:

- useful env/runtime hardening
- a physical DB rename migration
- broad code renames
- chart-adjacent changes

Implication:

- extract the safe pieces
- do not treat the branch as a merge candidate

### 4. Dashboard feed breakage and Warbird rebuild are coupled

Half-broken dashboard feeds mean the engine cannot be validated honestly.

Implication:

- feed stabilization is a prerequisite for trustworthy Warbird verification

---

## Execution Strategy

### Strategy A: Stabilize first

First make `main` internally coherent again.

This means:

- one DB/runtime URL policy
- one verified feed matrix
- one documented current state

### Strategy B: Build new Warbird beside legacy

Do not rename the current BHG path in-place as the first move.

Instead:

- create new Warbird-named engine files beside legacy
- port logic intentionally
- verify outputs block by block
- keep legacy as a comparison baseline until parity is proven

### Strategy C: Archive after proof

Legacy is archived only when:

- feed health is green
- Warbird path is verified
- output parity or justified divergence is documented

---

## Phase Blocks

### Phase 0A: Runtime and DB Contract Hardening

Goal:

- make `main` use one coherent server/runtime DB resolution policy

Primary extraction candidates from branch-only work:

- `prisma.config.ts`
- `src/lib/prisma.ts`
- `src/lib/direct-pool.ts`
- `src/lib/fetch-candles.ts`
- `src/lib/server-env.ts` as a new file
- `scripts/ingest-fred-news.ts`
- `scripts/ingest-market-prices.ts`
- `scripts/ingest-mm-signals.ts`
- `scripts/backfill-futures-all.ts`

Rules:

- port only DB/runtime hardening
- do not port physical table rename work
- do not port broad Warbird rename work yet

Verification gate:

- local DB probe succeeds through runtime Prisma and direct pool
- targeted scripts no longer require `DATABASE_URL` when direct/local URLs are present
- no new chart/frontend behavior changes

### Phase 0B: Dashboard Feed Recovery Matrix

Goal:

- document which feeds/routes are broken, why, and who owns each fix

Minimum matrix:

- `/api/gpr`
- `/api/pivots/mes`
- `/api/setups`
- `/api/live/mes15m`
- `/api/forecast`
- `/api/inngest`
- `/api/trades/upcoming`
- any homepage/dashboard data surfaces currently failing or stale

For each entry record:

- owner file(s)
- data source
- DB dependency
- current failure mode
- required fix block
- verification command or probe

Verification gate:

- every route/feed is marked green, yellow, or red with a concrete reason
- no unknowns remain in the active dashboard data path

### Phase 0C: Warbird Engine Skeleton Beside Legacy

Goal:

- create new Warbird-named engine surfaces without deleting the legacy BHG path

Initial new surfaces:

- `src/lib/warbird-engine.ts`
- `src/lib/warbird-setup-recorder.ts`
- `scripts/build-warbird-dataset.ts`
- `scripts/warbird-engine.test.ts`
- optional new chart primitive and adapter files only if they do not change the frozen chart contract

Legacy remains in place during this block:

- `src/lib/bhg-engine.ts`
- `src/lib/bhg-setup-recorder.ts`
- `scripts/build-bhg-dataset.ts`
- current recorder/tracker/runtime paths

Verification gate:

- new Warbird files build cleanly
- new engine tests run cleanly
- legacy path still works unchanged

### Phase 0D: Parity Adapter and Comparison Harness

Goal:

- compare new Warbird engine behavior against legacy on the same data

Required outputs:

- setup count comparison
- target/stop comparison
- phase transition comparison
- known intentional differences called out explicitly

Verification gate:

- side-by-side comparison is written down
- differences are classified as bug, intentional improvement, or unresolved

### Phase 0E: Data Contract for Warbird

Goal:

- define how new Warbird code names map to current DB/storage reality without breaking runtime

Default Phase 0 posture:

- no physical DB rename
- no destructive migration
- if needed, use logical naming in code first

Allowed later only after stabilization:

- additive Warbird staging tables
- explicit data migration plan
- archive plan for legacy tables/files

Verification gate:

- Warbird naming contract is documented
- DB object strategy is explicit

---

## Later Phases

### Phase 1: Pine Engine Hardening

Focus:

- Warbird fib engine behavior
- measured-move implementation/hardening
- anchor stability
- no visible chart contract break

### Phase 2: Replay and Setup Dataset

Focus:

- Python parity engine
- replay labels
- canonical Warbird setup dataset

### Phase 3: Scoring and Feature Enrichment

Focus:

- event/regime/cross-asset/news/options feature layers
- empirical T1/T2 hit modeling
- probability calibration

### Phase 4: Dashboard Integration

Focus:

- data wiring only at first
- no frozen chart contract break

### Phase 5: Archive Legacy

Focus:

- archive or delete BHG-era files only after verification gates pass

---

## Explicit Do-Not-Port-Yet Items From `warbird/phase-0-rename`

Do not pull these into `main` during Phase 0A without a separate review:

- physical rename migration `20260312120000_rename_bhg_to_warbird`
- broad schema/table rename assumptions
- broad chart file changes
- any “merge branch” style cleanup bundle

---

## Persistent Checklist

This plan remains the narrative source of truth.

The live execution surface is the tasklist:

- [2026-03-13-warbird-master-tasklist.md](./2026-03-13-warbird-master-tasklist.md)

Update the tasklist whenever a block starts, pauses, verifies, or closes.

---

## Definition of Done for Phase 0

Phase 0 is done only when:

- `main` has one coherent DB/runtime contract
- dashboard feed failures are fully inventoried and owned
- new Warbird engine files exist beside legacy
- parity comparison exists
- the next implementation block can proceed without guessing

If any of those are missing, Phase 0 is not done.
