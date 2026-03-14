# Warbird Production Tasklist

**Date:** 2026-03-13
**Status:** Active production checklist
**Parent plan:** [2026-03-13-warbird-phase-0-broken-state-plan.md](./2026-03-13-warbird-phase-0-broken-state-plan.md)
**Execution mode:** `main` only, one block at a time

---

## Non-Negotiables

- Stay on `main`
- Do not merge `warbird/phase-0-rename` wholesale
- Do not apply a physical DB rename in Phase 0
- Do not change the frozen MES chart frontend contract
- Do not mark a phase done without written proof

---

## Current Verified State

- Production/runtime drift still exists on `main`
- `main` does not contain the branch-only DB/runtime hardening from `ff2cc6c` and `138e302`
- The reachable DB still exposes `bhg_setups` and enum `BhgPhase`
- Active BHG runtime surfaces still exist in `prisma/schema.prisma`, `src/lib/bhg-engine.ts`, `src/lib/bhg-setup-recorder.ts`, `src/lib/trigger-candidates.ts`, `src/lib/outcome-tracker.ts`, `scripts/build-bhg-dataset.ts`, and `scripts/train-fib-scorer.py`
- Active dashboard/feed routes in scope are:
  - `src/app/api/gpr/route.ts`
  - `src/app/api/pivots/mes/route.ts`
  - `src/app/api/setups/route.ts`
  - `src/app/api/live/mes15m/route.ts`
  - `src/app/api/forecast/route.ts`
  - `src/app/api/inngest/route.ts`
  - `src/app/api/trades/upcoming/route.ts`

---

## Master Phase Status

- [-] Phase 0: Stabilize production baseline
- [ ] Phase 1: Harden the Pine engine
- [ ] Phase 2: Build replay and setup dataset
- [ ] Phase 3: Add scoring and enrichment
- [ ] Phase 4: Wire verified Warbird outputs into production routes
- [ ] Phase 5: Archive legacy BHG surfaces

---

## Phase 0: Stabilize Production Baseline

**Exit criteria**

- `main` has one DB/runtime resolution policy
- dashboard/feed matrix is written with concrete status per route
- new Warbird engine files exist beside legacy
- parity comparison is written down
- Warbird naming/data contract is explicit

### 0A: Runtime and DB Contract Hardening

**Status:** `[ ]`

**This block changes**

- `prisma.config.ts`
- `src/lib/prisma.ts`
- `src/lib/direct-pool.ts`
- `src/lib/fetch-candles.ts`
- `src/lib/server-env.ts` as a new shared resolver file
- `scripts/ingest-fred-news.ts`
- `scripts/ingest-market-prices.ts`
- `scripts/ingest-mm-signals.ts`
- `scripts/backfill-futures-all.ts`
- `scripts/ingest-market-prices-daily.ts`

**This block copies from branch only if safe**

- `ff2cc6c`
- `138e302`

**This block must not copy**

- `0f05685` physical rename migration
- `d858a98` broad schema/table rename assumptions
- `edc67b4` chart-adjacent rename bundle

**Required output**

- one shared env resolver used by runtime and scripts
- `fetch-candles` DB readiness logic aligned with Prisma/direct-pool logic
- `fetch-candles` no longer latches permanently to `failed`; transient DB errors retry in-process
- no `DATABASE_URL required` hard-fails in the targeted scripts when `DIRECT_URL` or `LOCAL_DATABASE_URL` is present
- targeted bulk-write scripts require direct/local DB access and explicitly reject DATABASE_URL/Accelerate-only preflight

**Verification**

- `npx tsc --noEmit`
- `npx tsx scripts/db-check.ts`
- `rg -n "DATABASE_URL is required|DATABASE_URL required" scripts/ingest-fred-news.ts scripts/ingest-market-prices.ts scripts/ingest-mm-signals.ts scripts/backfill-futures-all.ts scripts/ingest-market-prices-daily.ts`

**Done when**

- `src/lib/server-env.ts` exists on `main`
- targeted scripts no longer encode Accelerate-first assumptions
- DB probes succeed through runtime Prisma and direct pool without chart changes
- `fetch-candles` retries DB probes after transient failures without process restart
- bulk-write script preflight uses direct/local-only resolution consistently

**Evidence**

- Pending

---

### 0B: Dashboard Feed Recovery Matrix

**Status:** `[x]`

**Routes that must be audited**

- `/api/gpr` -> `src/app/api/gpr/route.ts`
- `/api/pivots/mes` -> `src/app/api/pivots/mes/route.ts`
- `/api/setups` -> `src/app/api/setups/route.ts`
- `/api/live/mes15m` -> `src/app/api/live/mes15m/route.ts`
- `/api/forecast` -> `src/app/api/forecast/route.ts`
- `/api/inngest` -> `src/app/api/inngest/route.ts`
- `/api/trades/upcoming` -> `src/app/api/trades/upcoming/route.ts`

**Required output**

- one row per route with:
  - current status: green, yellow, or red
  - owner file
  - direct data dependency
  - exact failure mode
  - fix owner block
  - verification probe

**Minimum dependency notes that must be captured**

- `/api/gpr` reads `prisma.geopoliticalRisk`
- `/api/pivots/mes` reads `prisma.mktFuturesMes1d`
- `/api/setups` depends on MES 15m derivation plus `generateTriggerCandidates`
- `/api/live/mes15m` depends on `readLatestMes1mRows`
- `/api/forecast` depends on `fetch-candles`, cross-symbol candle fetches, and forecast generation
- `/api/trades/upcoming` is cache-backed and fails when signal cache is empty

**Verification**

- every listed route has a written status and dependency owner
- no active dashboard route remains “unknown”

**Done when**

- the route matrix is written into this file or a linked proof doc
- every broken route is attached to a concrete fix block

**Evidence**

- [Phase 0B dashboard feed recovery matrix](./2026-03-13-warbird-phase-0b-dashboard-feed-recovery-matrix.md)

**Execution blocks (pending)**

#### 0B-B1: Feed freshness and empty-data response contract

**Status:** `[x]`

**Scope**

- normalize empty/partial/stale response handling for dashboard feed routes that read market or risk tables directly

**Affected routes**

- `/api/gpr`
- `/api/pivots/mes`
- `/api/live/mes15m`

**Expected output**

- explicit route contracts for empty vs stale vs runtime failure states
- route probes for each route documented in evidence

**Verification**

- `npx tsc --noEmit`
- `curl -si http://localhost:3000/api/gpr | head -n 20`
- `curl -si http://localhost:3000/api/pivots/mes | head -n 20`
- `curl -si "http://localhost:3000/api/live/mes15m?poll=1&bars=12" | head -n 20`

**Evidence**

- `2026-03-13`: contract hardening landed in:
  - `src/app/api/gpr/route.ts`
  - `src/app/api/pivots/mes/route.ts`
  - `src/app/api/live/mes15m/route.ts`
- added non-breaking `meta` payloads for explicit freshness/coverage/empty-source/runtime-failure state while preserving existing route contracts

**Handoff phase**

- none; closes in Phase 0 before engine caller flips

#### 0B-B2: Setups route hardening at trigger seam

**Status:** `[x]`

**Scope**

- harden `/api/setups` failure semantics around MES 15m derivation and trigger-candidate seam so route behavior is deterministic before engine swap

**Affected routes**

- `/api/setups`

**Expected output**

- deterministic contract for insufficient bars, derivation failure, and trigger-generation failure
- explicit handoff seam for Warbird engine implementation without immediate caller flip

**Verification**

- `npx tsc --noEmit`
- `curl -si http://localhost:3000/api/setups | head -n 30`
- `curl -s http://localhost:3000/api/setups | jq '{status: .meta.status, engine: .meta.engine, setups: (.setups|length), error}'`

**Evidence**

- `2026-03-13`: deterministic route-state buckets implemented in `src/app/api/setups/route.ts` with additive `meta` only:
  - `insufficient-source-data`
  - `derivation-failure`
  - `trigger-generation-failure`
  - `empty-success`
  - `full-success`
- trigger seam is explicit in response metadata:
  - `meta.engine.seam = "trigger-candidates-adapter"`
  - `meta.engine.generator = "generateTriggerCandidates"`
  - `meta.engine.backing = "legacy-bhg-adapter"`
  - `meta.engine.handoffPhases = ["0C", "0D", "4"]`

**Handoff phase**

- `0C` for Warbird engine skeleton at the seam
- `0D` for parity comparison against legacy outputs
- `4` for verified production caller flip

#### 0B-B3: Forecast degradation contract

**Status:** `[x]`

**Scope**

- harden `/api/forecast` degradation behavior across DB-data gaps and AI-unavailable conditions

**Affected routes**

- `/api/forecast`

**Expected output**

- deterministic route contract for data-unavailable vs AI-unavailable outcomes
- verification probes pinned for refresh and failure-path checks

**Verification**

- `npx tsc --noEmit`
- `curl -si "http://localhost:3000/api/forecast?refresh=true" | head -n 30`
- `curl -s "http://localhost:3000/api/forecast?refresh=true" | jq '{status: .meta.status, source: .meta.source, error}'`

**Evidence**

- `2026-03-13`: additive `meta` route-state contract implemented in `src/app/api/forecast/route.ts`:
  - `full-success`
  - `data-unavailable`
  - `ai-unavailable`
  - `runtime-failure`
- data gaps are machine-distinguishable by source:
  - `meta.source = "intraday-market-data"` (no symbol candles)
  - `meta.source = "daily-market-context"` (no daily context candles)
- AI failures are machine-distinguishable:
  - `meta.status = "ai-unavailable"`
  - `meta.source = "ai-provider"`
- existing success payload fields are preserved; no deterministic non-AI fallback forecast added

**Handoff phase**

- `4` for final Warbird-backed forecast wiring after contract hardening

#### 0B-B4: Inngest served-surface vs runtime-health split

**Status:** `[x]`

**Scope**

- separate `/api/inngest` serve-surface availability from downstream scheduled-function runtime health checks

**Affected routes**

- `/api/inngest`

**Expected output**

- explicit health contract that distinguishes route serve health from function execution health
- verification probes for both surfaces

**Verification**

- `npx tsc --noEmit`
- `curl -si "http://localhost:3000/api/inngest?probe=health" | head -n 30`
- `curl -s "http://localhost:3000/api/inngest?probe=health" | jq`

**Evidence**

- `2026-03-13`: probe-safe additive health contract implemented in `src/app/api/inngest/route.ts`:
  - `GET /api/inngest?probe=health` returns machine-readable serve-surface metadata with `Cache-Control: no-store`
  - response explicitly separates route serve status (`status: "serve-surface-healthy"`) from runtime execution status (`runtimeHealth.status: "unknown"`, `verifiedByRoute: false`)
  - response exposes served-vs-exported drift through `registrySurface.exportedNotServed`, `servedNotExported`, and `hasDrift`
- normal Inngest traffic remains intact:
  - default `GET` falls through to `handlers.GET`
  - `PUT` continues direct passthrough
  - `POST` probe normalization (`probe=ping` -> `probe=trust`) remains unchanged

**Handoff phase**

- none; closes in Phase 0 baseline hardening

#### 0B-B5: Upcoming trades cache warm/cold resilience

**Status:** `[x]`

**Scope**

- harden cache-backed `/api/trades/upcoming` behavior for cold start and missed compute cycles

**Affected routes**

- `/api/trades/upcoming`

**Expected output**

- deterministic warm/cold cache response contract
- explicit behavior for empty cache and recovery window

**Verification**

- `npx tsc --noEmit`
- `curl -si http://localhost:3000/api/trades/upcoming | head -n 30`
- `curl -s http://localhost:3000/api/trades/upcoming | jq '{status: .meta.status, stale: .meta.isStale, age: .meta.cacheAgeSeconds, error}'`

**Evidence**

- `2026-03-13`: deterministic additive cache-state contract implemented in `src/app/api/trades/upcoming/route.ts`:
  - `meta.status` values: `warm-cache`, `cold-cache`, `stale-cache`, `runtime-failure`
  - machine-readable freshness fields: `meta.cacheAgeSeconds`, `meta.isStale`, `meta.expectedCadenceSeconds`, `meta.staleAfterSeconds`, `meta.recoveryWindowSeconds`
  - success payload fields are preserved: `trades`, `eventContext`, `currentPrice`, `fibResult`, `timestamp`, `computedAt`, `source`
- cache/header behavior hardened without changing compute-signal writer:
  - warm cache (`200`) keeps public cache headers
  - cold/stale/runtime-failure states (`503`/`200`/`500`) return `Cache-Control: no-store`
  - route remains cache-reader only (no DB fallback, no route-triggered compute)

**Handoff phase**

- `4` for Warbird-backed production route wiring after cache contract hardening

#### 0B-B6: Chart-adjacent AI synthesis shutdown

**Status:** `[x]`

**Scope**

- shut down the under-chart AI synthesis surface by disconnecting it at the mount/render layer in `src/components/MesIntraday/IntelligenceConsole.tsx`
- preserve the synthesis module for later reuse; do not delete `src/components/MesIntraday/Widgets/AiSynthesisBillboard.tsx`, `src/hooks/useAiSynthesis.ts`, or `/api/ai/synthesis`

**Affected surface**

- `src/components/MesIntraday/IntelligenceConsole.tsx`
- `src/components/MesIntraday/Widgets/AiSynthesisBillboard.tsx` (preserved, not mounted)
- `src/hooks/useAiSynthesis.ts` (preserved, not mounted)

**Expected output**

- the AI synthesis billboard under the chart is not rendered
- under-chart UI no longer triggers synthesis fetches
- the rest of the `IntelligenceConsole` widget layout remains intact

**Verification**

- `npx tsc --noEmit`
- static proof in `src/components/MesIntraday/IntelligenceConsole.tsx` that:
  - `useAiSynthesis` is no longer imported or called
  - `AiSynthesisBillboard` is no longer imported or rendered
  - `ForecastMomentumWidget`, `CrossAssetAlignmentWidget`, and `RiskEventWidget` remain mounted

**Evidence**

- `2026-03-13`: implemented shutdown in `src/components/MesIntraday/IntelligenceConsole.tsx` by removing `useAiSynthesis` hook wiring and `<AiSynthesisBillboard />` mount while keeping the synthesis hook/component files intact for reuse

**Handoff phase**

- none; closes in Phase 0

#### 0B-B7: MES chart freshness owner-path proof

**Status:** `[x]`

**Scope**

- verify and harden end-to-end MES chart freshness through the authoritative 1m Databento owner path without changing the frozen chart frontend contract
- treat Databento credential/env wiring and the `mkt-mes-1m` writer freshness as first-class chart data dependencies

**Affected routes**

- `/api/live/mes15m`

**Affected owner path**

- `src/inngest/functions/mkt-mes-1m.ts`
- `src/app/api/live/mes15m/route.ts`
- `src/lib/mes-live-queries.ts`

**Expected output**

- explicit freshness proof for the chart owner path from Databento-backed 1m ingestion through `/api/live/mes15m`
- machine-readable and operator-readable evidence for stale-vs-fresh chart data
- credential/env dependency called out without echoing secrets into code, docs, or prompts

**Verification**

- `npx tsc --noEmit`
- `curl -si "http://localhost:3000/api/live/mes15m?poll=1&bars=12" | head -n 30`
- `curl -s "http://localhost:3000/api/live/mes15m?poll=1&bars=12" | jq`

**Evidence**

- `2026-03-13`: owner-path freshness contract hardened with additive metadata only:
  - `src/lib/mes-live-queries.ts`: added shared MES 1m owner-path contract constants and `readMes1mFreshnessSnapshot()` telemetry query (`latestEventTime`, `rowsLast5m`, `rowsLast15m`, `rowsLast60m`)
  - `src/app/api/live/mes15m/route.ts`: existing chart fields remain intact (`points`, `live`, `changed`, `fingerprint`); `meta` extended with:
    - `meta.attribution`: `owner-path-healthy`, `owner-path-freshness-lag`, `no-recent-1m-rows`, `reader-path-runtime-failure`, `market-closed`, `owner-path-telemetry-unavailable`
    - `meta.ownerPath`: authoritative writer identity (`ingest-mkt-mes-1m`), owner mode, source table/provider, cadence/lag thresholds, latest 1m row time/age, row counts, lag state
  - stale/blocked attribution is now machine-distinguishable:
    - no recent 1m rows -> `meta.attribution = "no-recent-1m-rows"`
    - owner freshness lag -> `meta.attribution = "owner-path-freshness-lag"`
    - reader/runtime failure -> `meta.attribution = "reader-path-runtime-failure"`
- `src/inngest/functions/mkt-mes-1m.ts`: added minimal non-invasive return telemetry (`ownerFreshness`) referencing shared owner-path constants; no scheduler or write-path behavior changes

**Handoff phase**

- none; closes in Phase 0 baseline hardening

---

### 0C: Warbird Engine Skeleton Beside Legacy

**Status:** `[ ]`

**Legacy files to leave in place**

- `src/lib/bhg-engine.ts`
- `src/lib/trigger-candidates.ts`
- `src/lib/bhg-setup-recorder.ts`
- `src/lib/outcome-tracker.ts`
- `scripts/build-bhg-dataset.ts`
- `scripts/bhg-engine.test.ts`
- `scripts/trigger-candidates.test.ts`

**New files expected from this block**

- `src/lib/warbird-engine.ts`
- `src/lib/warbird-setup-recorder.ts`
- `scripts/build-warbird-dataset.ts`
- `scripts/warbird-engine.test.ts`

**Required output**

- first Warbird engine surface compiles beside legacy
- no production caller flip yet
- no DB object rename yet
- `0B-B2` handoff part 1: implement the Warbird engine seam consumed by `/api/setups` without flipping the production caller yet

**Verification**

- `npx tsc --noEmit`
- working test command for new Warbird engine pinned in this section before close
- existing legacy trigger tests still pass after the new files land

**Done when**

- new Warbird files exist and compile
- legacy BHG path remains callable without change

**Evidence**

- Pending

---

### 0D: Parity Adapter and Comparison Harness

**Status:** `[ ]`

**Inputs to compare**

- same MES 15m candle window
- same fib result input
- same measured-move input

**Required output**

- setup count diff
- phase transition diff
- target and stop diff
- explicit classification of each difference:
  - bug
  - intentional improvement
  - unresolved
- `0B-B2` handoff part 2: parity report for `/api/setups` seam output before any production caller flip

**Verification**

- one written parity report linked from this section
- report names the exact input window used

**Done when**

- there is no silent behavior drift between legacy and Warbird
- every observed difference has an owner and disposition

**Evidence**

- Pending

---

### 0E: Warbird Data Contract

**Status:** `[ ]`

**Current BHG-named surfaces that must be mapped or retired**

- `prisma/schema.prisma`
- `src/lib/bhg-engine.ts`
- `src/lib/bhg-setup-recorder.ts`
- `src/lib/trigger-candidates.ts`
- `src/lib/outcome-tracker.ts`
- `src/app/api/setups/history/route.ts`
- `scripts/build-bhg-dataset.ts`
- `scripts/build-regime-lookup.ts`
- `scripts/train-fib-scorer.py`
- `datasets/autogluon/warbird_setups.csv`

**Facts already verified**

- `datasets/autogluon/bhg_setups.csv` is gone by design
- active builders and trainers still point at `bhg_setups.csv`
- DB is still physically `bhg_setups` / `BhgPhase`

**Required output**

- explicit logical mapping from:
  - `BhgSetup` -> `WarbirdSetup`
  - `BhgPhase` -> `WarbirdPhase`
  - `bhg_setups` -> mapped legacy DB object or later migration target
- explicit dataset contract for `datasets/autogluon/warbird_setups.csv`

**Verification**

- `rg -n "Bhg|bhg_|GO_FIRED" prisma/schema.prisma src/lib scripts src/app/api/setups src/inngest indicators`
- active Warbird path no longer depends on `bhg_setups.csv`

**Done when**

- Warbird naming is defined without pretending the DB is already renamed
- the future migration decision is separated from current runtime code

**Evidence**

- Pending

---

## Phase 1: Harden the Pine Engine

**Status:** `[ ]`

**Primary file**

- `indicators/rabid-raccoon.pine`

**Known issues already seen**

- BHG-facing labels/inputs still exist
- measured-move section is still a TODO stub

**Required output**

- Warbird naming in the Pine surface
- measured-move behavior implemented or hardened
- anchor behavior remains stable under small chart changes
- target extensions stay `1.236` and `1.618`

**Verification**

- manual MES 15m chart check after reload
- manual MES 15m chart check after zoom in/out
- manual MES 15m chart check after extending the right edge
- no visible break to the existing chart feel

**Done when**

- the Pine file is Warbird-aligned and no longer depends on BHG language
- anchor stability is written down as passed or failed with screenshots/proof location

**Evidence**

- Pending

---

## Phase 2: Build Replay and Setup Dataset

**Status:** `[ ]`

**Primary files**

- `scripts/build-warbird-dataset.ts`
- `scripts/build-regime-lookup.ts`
- `scripts/train-fib-scorer.py`
- `datasets/autogluon/warbird_setups.csv`

**Required output**

- Python replay/parity engine for the stabilized Warbird logic
- dataset with:
  - T1 hit
  - T2 hit
  - stop-first
  - MAE
  - MFE
  - time-to-target
  - setup score
  - regime context

**Verification**

- `datasets/autogluon/warbird_setups.csv` exists and is non-empty
- active replay/dataset code no longer tries to restore `bhg_setups.csv`
- column set is written down in the evidence section

**Done when**

- the canonical Warbird setup dataset can be rebuilt from code
- the dataset contract is stable enough for model work

**Evidence**

- Pending

---

## Phase 3: Add Scoring and Enrichment

**Status:** `[ ]`

**Primary files**

- `scripts/build-lean-dataset.ts`
- `src/lib/trade-features.ts`
- training scripts added for Warbird probability work

**Required output**

- regime, cross-asset, macro, news, options, and feedback feature layers on top of the setup dataset
- empirical T1/T2 hit modeling
- pinball or quantile-oriented outputs
- Monte Carlo and GARCH integration plan implemented only after dataset proof

**Hard constraints**

- train `1h` and `4h` first
- max `5` folds
- sequential local fitting
- no local AI workloads during training

**Done when**

- Warbird scoring moves beyond raw setup generation into verified probability work

**Evidence**

- Pending

---

## Phase 4: Wire Verified Warbird Outputs Into Production

**Status:** `[ ]`

**Primary files**

- `src/app/api/setups/route.ts`
- `src/app/api/setups/history/route.ts`
- `src/app/api/trades/upcoming/route.ts`
- `src/app/api/forecast/route.ts`
- supporting backend libraries only

**Required output**

- Warbird-backed data on production routes
- no visible change to the frozen MES chart contract
- route contracts documented before caller flips
- `/api/setups` caller flip only after `0B-B2`, `0C`, and `0D` are closed
- `/api/forecast` Warbird-backed wiring only after `0B-B3` contract hardening is closed
- `/api/trades/upcoming` production flip only after `0B-B5` warm/cold cache resilience is closed

**Must not change in this phase**

- `src/components/LiveMesChart.tsx` visual behavior
- chart spacing, viewport, marker feel, or interaction model

**Done when**

- production routes read verified Warbird outputs
- chart-visible behavior remains unchanged

**Evidence**

- Pending

---

## Phase 5: Archive Legacy BHG Surfaces

**Status:** `[ ]`

**Likely archive/delete candidates**

- `src/lib/bhg-engine.ts`
- `src/lib/bhg-setup-recorder.ts`
- `scripts/build-bhg-dataset.ts`
- `scripts/bhg-engine.test.ts`
- `src/lib/charts/BhgMarkersPrimitive.ts`
- any remaining BHG-only support code proven unused after caller flips

**Required output**

- explicit archive list
- proof that each archived surface has a Warbird replacement
- controlled removal in small batches

**Done when**

- BHG is legacy only, not active production wiring
- deleted surfaces are backed by proof, not assumption

**Evidence**

- Pending

---

## Ready Queue

Current next block:

- Phase `0C` Warbird engine skeleton beside legacy

Queued after current block:

- Phase `0D` parity adapter and comparison harness

Still blocked:

- physical DB rename
- broad BHG-to-Warbird repo-wide rename
- legacy archive/delete before parity proof
- chart-visible changes

---

## Change Log

- `2026-03-13`: executed `0B-B7` MES chart freshness owner-path proof by extending `/api/live/mes15m` metadata with explicit owner-path attribution (`owner-path-freshness-lag` vs `no-recent-1m-rows` vs `reader-path-runtime-failure`) and shared MES 1m freshness telemetry (`latest row + recent row counts`) tied to authoritative writer `ingest-mkt-mes-1m`
- `2026-03-13`: executed `0B-B5` upcoming trades cache warm/cold resilience with additive `meta` states (`warm-cache`, `cold-cache`, `stale-cache`, `runtime-failure`), explicit freshness metadata (`cacheAgeSeconds`, cadence/recovery window), and no-store headers for non-success states in `/api/trades/upcoming`
- `2026-03-13`: executed `0B-B4` Inngest served-surface vs runtime-health split by adding probe-safe `GET /api/inngest?probe=health` metadata (`serveSurface`, `runtimeHealth`, `registrySurface`) while preserving normal Inngest `GET/PUT/POST` serve behavior
- `2026-03-13`: executed `0B-B3` forecast degradation contract with deterministic additive `meta` states (`full-success`, `data-unavailable`, `ai-unavailable`, `runtime-failure`) and explicit data-vs-AI source classification in `/api/forecast`
- `2026-03-13`: executed `0B-B2` setups route hardening with deterministic route-state buckets, explicit trigger-seam metadata, and non-breaking additive `meta` contract updates in `/api/setups`
- `2026-03-13`: executed `0B-B1` feed freshness and empty-data response contract for `/api/gpr`, `/api/pivots/mes`, and `/api/live/mes15m` with additive metadata and deterministic empty-source/runtime-failure states
- `2026-03-13`: integrated Phase 0B follow-up execution surface into the master tasklist with pending blocks `0B-B1` through `0B-B5` and explicit cross-phase handoffs into `0C`, `0D`, and `4`
- `2026-03-13`: completed Phase 0B dashboard feed recovery matrix proof doc with route-by-route status, dependencies, fragilities, owner blocks, and verification probes
- `2026-03-13`: converted the Warbird checklist into a production tasklist with exact files, exact outputs, exact verification, and explicit no-go rules
- `2026-03-13`: completed `0B-B6` chart-adjacent AI synthesis shutdown by unmounting the under-chart AI synthesis path in `src/components/MesIntraday/IntelligenceConsole.tsx` while preserving `AiSynthesisBillboard`, `useAiSynthesis`, and `/api/ai/synthesis` for later reuse
