# Warbird Project Handover

**Date:** 2026-03-12
**From:** Claude Code (session terminated by Kirk)
**For:** Kirk / Codex / GPT / any successor tool

---

## 1. WHAT WAS COMPLETED

### Phase 0: BHG → Warbird Rename (DONE, NOT MERGED)

Branch `warbird/phase-0-rename` has 4 commits on top of `main`:

```
0f05685 feat: rename BhgSetup → WarbirdSetup in Prisma schema
d858a98 refactor: rename BHG engine files to Warbird
edc67b4 refactor: complete BHG → Warbird rename across codebase
26085cd fix: update WarbirdMarkersPrimitive to use WarbirdSetup type
```

**Verification status:**
- TypeScript build clean (`tsc --noEmit` passes)
- 4/4 engine tests pass (`scripts/warbird-engine.test.ts`)
- Prisma migration applied to db.prisma.io (migration `20260312120000_rename_bhg_to_warbird`)
- Dashboard renders on port 3001 — "1H PRICE TARGET (WARBIRD)" visible
- Zero remaining `BhgSetup` or `BhgPhase` references in src/ or scripts/

**TO MERGE:** `git checkout main && git merge warbird/phase-0-rename`

---

## 2. CURRENT BRANCH STATE

```
Current branch: warbird/phase-0-rename (checked out in main worktree)
Main HEAD:      d5fdedb fix: reduce mes 1m ingest end-lag for live chart freshness
Phase 0 HEAD:   26085cd fix: update WarbirdMarkersPrimitive to use WarbirdSetup type
```

**Dirty working directory (uncommitted, NOT part of Phase 0):**
```
Modified (pre-existing, not from rename):
  .env.example
  AGENTS.md
  docs/plans/2026-03-09-runtime-data-flow-audit.md
  next-env.d.ts
  next.config.mjs
  scripts/ingest-gpr-index.ts
  scripts/ingest-market-prices-daily.ts
  scripts/ingest-options.py
  scripts/submit-options-batch.py
  src/app/api/inngest/route.ts
  src/app/api/live/mes1m/route.ts
  src/app/api/ml-forecast/route.ts
  src/inngest/functions/econ-calendar.ts
  src/lib/databento.ts
  src/lib/fibonacci.ts
  src/lib/prisma.ts
  src/lib/symbol-registry/snapshot.json
  src/lib/symbol-registry/snapshot.ts

Untracked (plan docs from this and prior sessions):
  docs/plans/2026-03-11-claudes-warbird-design.md
  docs/plans/2026-03-11-research-capture-ledger.md
  docs/plans/2026-03-11-trigger-data-hit-map.md
  docs/plans/2026-03-11-warbird-readiness-audit.md
  docs/plans/2026-03-11-warbird-trigger-restart-checklist.md
  docs/plans/2026-03-12-warbird-master-build-plan.md
```

**Git stashes:**
```
stash@{0}: On codex/runtime-volume-quarantine: quarantine .mcp.json before prisma-ops pass
stash@{1}: WIP on codex/chart-card-setup-sync: fix(prisma): cap adapter-pg pool size
stash@{2}: On main: pre-warbird-baseline-2026-03-02
```

**Worktrees (Codex-created, all detached HEAD):**
14 Codex worktrees at `~/.codex/worktrees/*/rabid-raccoon` — all detached HEAD, safe to prune.
1 hotfix worktree at `/private/tmp/rabid-raccoon-hotfix` — marked prunable.

To clean: `git worktree prune`

---

## 3. DATABASE STATE

- **Primary DB:** `db.prisma.io:5432/postgres` (Prisma-managed Postgres)
- **31 migrations applied**, all up to date, including the BHG→Warbird rename
- **The rename migration uses ALTER TYPE and RENAME TABLE** — NOT drop+create. Safe, data-preserving.
- **Migration file:** `prisma/migrations/20260312120000_rename_bhg_to_warbird/migration.sql`
- **Table:** `warbird_setups` (was `bhg_setups`), enum `WarbirdPhase` (was `BhgPhase`)
- **Local Postgres** (`rabid_raccoon` on localhost:5432) may be out of sync — scripts/app write to db.prisma.io, not local

---

## 4. FILES CHANGED IN PHASE 0 (28 files vs main)

**Prisma:**
- `prisma/schema.prisma` — BhgSetup→WarbirdSetup, BhgPhase→WarbirdPhase
- `prisma/migrations/20260312120000_rename_bhg_to_warbird/migration.sql` — new

**Renamed files (git mv):**
- `src/lib/bhg-engine.ts` → `src/lib/warbird-engine.ts`
- `src/lib/bhg-setup-recorder.ts` → `src/lib/warbird-setup-recorder.ts`
- `src/lib/charts/BhgMarkersPrimitive.ts` → `src/lib/charts/WarbirdMarkersPrimitive.ts`
- `scripts/bhg-engine.test.ts` → `scripts/warbird-engine.test.ts`
- `scripts/build-bhg-dataset.ts` → `scripts/build-warbird-dataset.ts`
- `datasets/autogluon/bhg_setups.csv` → `datasets/autogluon/warbird_setups.csv`

**Import/reference updates (21 files):**
- `src/lib/types.ts`
- `src/lib/trigger-candidates.ts`
- `src/lib/trigger-candidate-recorder.ts`
- `src/lib/outcome-tracker.ts`
- `src/lib/ml-baseline.ts`
- `src/lib/risk-engine.ts`
- `src/components/LiveMesChart.tsx`
- `src/components/MesIntraday/IntelligenceConsole.tsx`
- `src/components/MesIntraday/MLForecastTile.tsx`
- `src/app/api/setups/history/route.ts`
- `src/inngest/functions/compute-signal.ts`
- `src/inngest/functions/check-trade-outcomes.ts`
- `scripts/trigger-candidates.test.ts`
- `scripts/build-lean-dataset.ts`
- `scripts/db-check.ts`
- `scripts/check-db-alignment.ts`
- `scripts/_staleness-audit.ts`
- `scripts/backtest-event-phases.ts`
- `scripts/train-core-forecaster.py`
- `scripts/build-regime-lookup.ts`
- `scripts/train-fib-scorer.py`

**NOTE:** `src/lib/types.ts` and `src/components/LiveMesChart.tsx` had pre-existing modifications (new FibLevel/FibResult properties, removed polling infrastructure) that were swept into the rename commits because both files also needed BHG→Warbird edits. These changes were NOT introduced by Phase 0.

---

## 5. WHAT REMAINS (Phases 1-8)

Full plan at: `docs/plans/2026-03-12-warbird-master-build-plan.md`

| Phase | Description | Risk Level |
|-------|-------------|------------|
| 1 | Pine indicator optimization (strip dead weight, add Fib test lines, EMAs, optimize fibScore, 89-bar window, harden re-anchoring) | LOW — Pine Script only, no API/DB |
| 2 | Fib engine backtest (Python port of TS fib engine + 12mo replay) | LOW — local compute only |
| 3 | Dataset builder (~257 columns from 16 feature groups, all 63 DB symbols as features) | MEDIUM — touches DB reads, Databento pulls |
| 4 | AutoGluon training (smoke test → 14-model full run, 2 horizons × 3 targets + 8 quantile) | LOW — local compute, weeks of training |
| 5 | Inference pipeline (predict.py rewrite for regression output) | LOW |
| 6 | Dashboard integration (target zones, probability display) | LOW |
| 7 | Monte Carlo (GJR-GARCH + 10K paths) | LOW |
| 8 | Feedback loop (outcome tracking, model refresh) | LOW |

---

## 6. DATABENTO DATASET PULL LIST (CORRECTED — CME ONLY)

**⚠️ BILLING GUARDRAIL:** Kirk's Databento subscription is **Standard CME (GLBX.MDP3) = $179/mo ONLY**.
- **NEVER** pull from `IFUS.IMPACT` (ICE) — generated $17.73 unauthorized charge
- **NEVER** pull from `DBEQ.BASIC` (US Equities) — generated $136.93 unauthorized charge
- VX on `XCBF.PITCH` (CBOE) — **UNVERIFIED** if Kirk's plan covers it. ASK FIRST.

### Safe pulls (all GLBX.MDP3):

| # | Symbol | Schema | Timeframe | Dataset |
|---|--------|--------|-----------|---------|
| 1 | MES.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 2 | NQ.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 3 | CL.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 4 | GC.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 5 | ZN.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 6 | ZB.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 7 | ZT.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 8 | ZF.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 9 | RTY.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 10 | BTC.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 11 | YM.c.0 | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 12 | *(REMOVED — was DX on IFUS.IMPACT)* | — | — | — |
| 13 | VX front month | ohlcv-1m | 2yr | `XCBF.PITCH` ⚠️ VERIFY |
| 14 | VX 2nd month | ohlcv-1m | 2yr | `XCBF.PITCH` ⚠️ VERIFY |
| 15 | CNH.c.0 (offshore yuan) | ohlcv-1m | 2yr | `GLBX.MDP3` |
| 16 | MES L2 book | mbp-10 | 12mo | `GLBX.MDP3` |
| 17 | MES trades | trades | 12mo | `GLBX.MDP3` |
| 18 | ES options definitions | definition | 12mo | `GLBX.MDP3` |
| 19 | ES options book | mbp-1 | 12mo | `GLBX.MDP3` |
| 20 | *(REMOVED — was HYG on DBEQ.BASIC)* | — | — | — |

**DX replacement:** Use FRED DXY index (free, daily) — `scripts/ingest-fred.ts`
**HYG replacement:** Use FRED BAMLH0A0HYM2 (ICE BofA High Yield spread, free, daily)

### Save locations:
```
datasets/databento/
  01-mes-1m/
  02-nq-1m/
  03-cl-1m/
  04-gc-1m/
  05-zn-1m/
  06-zb-1m/
  07-zt-1m/
  08-zf-1m/
  09-rty-1m/
  10-btc-1m/
  11-ym-1m/
  13-vx-front-1m/   ← only if CBOE verified
  14-vx-back-1m/    ← only if CBOE verified
  15-cnh-1m/
  16-mes-l2/
  17-mes-trades/
  18-es-opts-def/
  19-es-opts-book/
```

---

## 7. KNOWN ISSUES / LANDMINES

1. **`/api/forecast` returns 500** — Missing `OPENROUTER_API_KEY` in env. Pre-existing, not caused by rename.
2. **`/api/ai/synthesis` returns 503** — Pre-existing service unavailability. Not caused by rename.
3. **AGENTS.md is stale** — Still says 4 horizons (should be 2: 1h, 4h), 12 models (should be 14), references BHG in places. Kirk has been editing this file externally.
4. **`types.ts` has new FibLevel/FibResult properties** — These were pre-existing Kirk/Codex edits swept into the Phase 0 commit. They are NOT rename artifacts.
5. **`LiveMesChart.tsx` had polling infrastructure removed** — Same situation as above. Pre-existing change, committed alongside rename edits.
6. **Inngest MES jobs do NOT write to `ingestion_runs`** — They are invisible to bookkeeping. Known architectural gap.
7. **No true minute-cadence 1m writer exists** — Best cadence is ~7.5 min interleave between two Inngest functions.
8. **Databento rogue pull forensics** — A previous Claude session pulled from IFUS.IMPACT and DBEQ.BASIC without authorization, generating $154+ in extra charges on Kirk's February invoice. The investigation was incomplete when this session started.

---

## 8. KEY ARCHITECTURE NOTES FOR SUCCESSOR

- **ONE unified MES model** — NOT separate per-symbol. All 63 DB symbols are FEATURES, MES is the only target.
- **2 horizons** (1h, 4h), **3 targets** (price, MAE, MFE) = 6 core models + 8 quantile = **14 total**
- **AutoGluon 1.5** `best_quality_v150` preset, 5 folds max, `num_stack_levels=2`
- **Walk-forward CV** with purge (24h) + embargo (4h), Lopez de Prado methodology
- **Feature count:** 400-600+ columns (all 63 symbols + FRED + news/GPR/Trump + econ tables)
- **GJR-GARCH(1,1) + Monte Carlo 10K paths** — post-training inference for T1/T2 hit probabilities
- **Target zones** = horizontal Fibonacci-anchored price lines. NEVER say "cones", "bands", or "funnels"
- **CPU-bound sequential training** on M4 Pro 12 cores. Peak RAM 8-10GB. CPU is bottleneck.
- **NEVER run Ollama during training** — M4 Pro reserved for AutoGluon

---

## 9. ENVIRONMENT

- **Primary DB:** `db.prisma.io:5432/postgres` via Prisma Accelerate
- **Dev server:** port 3001 (rabid-raccoon), port 3000 (zinc-fusion-v15), port 8288 (Inngest)
- **NEVER kill port 3000** — cascades to Inngest on 8288
- **Prisma Accelerate:** 5s transaction timeout — batch upserts in chunks of 40
- **Entry guard fix:** All 10 ingest scripts use `isMainModule()` helper (path space encoding fix)
- **Env loading:** `.env.production.local` loaded FIRST (has DATABENTO_API_KEY, FRED_API_KEY)

---

## 10. PLAN FILE LOCATION

`/Volumes/Satechi Hub/rabid-raccoon/docs/plans/2026-03-12-warbird-master-build-plan.md`

This is the master execution document. 8 phases, fully specified with file paths, code snippets, test commands, and commit messages.

---

*End of handover.*
