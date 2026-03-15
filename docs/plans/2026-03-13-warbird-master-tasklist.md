# Warbird Canonical Working Checklist

**Date:** 2026-03-14  
**Status:** Active canonical working checklist  
**Scope authority:** [2026-03-14-warbird-canonical-teardown-spec.md](./2026-03-14-warbird-canonical-teardown-spec.md)  
**Execution mode:** `main` only, one block at a time  
**Replaces:** the prior pre-canonical Phase 1-5 layout in this file  
**Historical baseline:** preserve the approved Phase 0 evidence and additive scaffolding already landed on `main`

---

## Summary

- [x] Rewrite this file in place so it is the single active Warbird working plan on `main`.
- [x] Treat the March 14 canonical teardown spec as the sole scope authority for Warbird v1.
- [x] Use `AGENTS.md` only for governance, execution policy, and hard rules.
- [x] Preserve valid completed Phase 0 evidence instead of discarding approved work.
- [x] Keep blocking item `#4` open and blocked; do not invent numeric shadow-promotion thresholds.

---

## Non-Negotiables

- Stay on `main`.
- One scope source only: [2026-03-14-warbird-canonical-teardown-spec.md](./2026-03-14-warbird-canonical-teardown-spec.md).
- Do not let older tasklists, Downloads drafts, or branch-only plans add scope.
- Do not apply a destructive DB rename or migration in this lane.
- Do not change the frozen MES chart frontend contract.
- Do not move Phase 2 or Phase 3 work into Warbird v1 active execution.
- Do not leave contradictory repo surfaces floating without classification.
- Do not mark a phase complete without written proof and pinned verification.

---

## Current Verified State

- The repo still contains active BHG-named runtime and schema surfaces:
  - `prisma/schema.prisma`
  - `src/lib/bhg-engine.ts`
  - `src/lib/bhg-setup-recorder.ts`
  - `src/lib/trigger-candidates.ts`
  - `src/lib/outcome-tracker.ts`
  - `scripts/build-bhg-dataset.ts`
  - `scripts/train-fib-scorer.py`
- The current reachable schema and runtime mapping still use physical `bhg_setups` and `BhgPhase`; additive Warbird bridging remains in effect.
- Additive Warbird scaffolding already exists and is approved:
  - `src/lib/warbird-engine.ts`
  - `src/lib/warbird-setup-recorder.ts`
  - `scripts/warbird-engine.test.ts`
  - `scripts/warbird-setup-recorder.test.ts`
- `scripts/train-warbird.py` is partially aligned but not yet canonical end-to-end:
  - now trains only `1h` and `4h`
  - now exposes the six v1 target names and a price-space vs return-space ablation switch
  - now locks `num_stack_levels=1` and excludes `KNN`, `FASTAI`, `RF`
  - still requires remaining Phase 3 data-contract and artifact reconciliation before it can be treated as the canonical v1 trainer
- `scripts/train-core-forecaster.py` and `scripts/predict.py` still represent an older core-forecaster/export lane that conflicts with the locked v1 contract and must be classified.
- `src/app/api/ml-forecast/route.ts`, `src/components/MesIntraday/MLForecastTile.tsx`, and `public/ml-predictions.json` still speak the legacy directional payload shape rather than `WarbirdSignal v1.0`.
- The current `public/ml-predictions.json` payload is file-backed and directional-first; it does not yet carry a versioned Warbird inference contract.
- Supporting setup-outcome surfaces now point at `datasets/autogluon/warbird_setups.csv`, but that entire scorer lane remains supporting or deferred rather than active Warbird v1 scope.
- Completed Phase 0 route hardening and Warbird scaffolding on `main` remain valid and must be carried forward, not overwritten.

---

## Coverage Lock

- [x] Sections 1-3 of the canonical spec map to the contract and architecture phase in this checklist.
- [x] Sections 4-9 map to architecture rules, volume rules, regime rules, and label taxonomy in this checklist.
- [x] Sections 10-11 map to the data foundation and feature-reconciliation phase in this checklist.
- [x] Section 12 plus mismatches 1, 2, 6, and 7 map to the core-forecaster and GARCH phase in this checklist.
- [x] Section 13 maps to the inference-contract and consumer-migration phase in this checklist.
- [x] Sections 14-20 map to deferred scope, blockers, backfills, transition rules, decision carry-forward, and retirement in this checklist.
- [x] The full seven-mismatch list is carried explicitly below, each marked as resolved, active, or blocked.

---

## Preserved Phase 0 Baseline

- [x] Preserve completed Phase 0A runtime and DB hardening evidence.
- [x] Preserve completed `0B-B1` feed freshness and empty-data response contract.
- [x] Preserve completed `0B-B2` setups route hardening at the trigger seam.
- [x] Preserve completed `0B-B3` forecast degradation contract.
- [x] Preserve completed `0B-B4` Inngest served-surface vs runtime-health split.
- [x] Preserve completed `0B-B5` upcoming-trades cache warm/cold resilience.
- [x] Preserve completed `0B-B6` chart-adjacent AI synthesis shutdown.
- [x] Preserve completed `0B-B7` MES chart freshness owner-path proof.
- [x] Preserve completed `0C-1` additive Warbird engine surface beside legacy.
- [x] Preserve completed `0C-2` additive Warbird setup-recorder bridge to legacy storage.
- [x] Preserve completed `0C-3` Warbird-owned pure state-machine helpers.
- [x] Preserve completed `0C-4` Warbird-owned target computation with tick-size rules retained.
- [x] Preserve completed `0C-5` pure Warbird advancement path proof while the public export remains delegated.
- [x] Keep `0D` parity report complete and pinned as a required prerequisite before any production caller flip.
- [x] Keep `0E` explicit Warbird/BHG data-contract and naming-map work complete and pinned as transition evidence.

### 0A: Runtime and DB Contract Hardening

- [x] Approved Phase 0A evidence preserved in this working plan.

**Scope files**

- `prisma.config.ts`
- `src/lib/prisma.ts`
- `src/lib/direct-pool.ts`
- `src/lib/fetch-candles.ts`
- `src/lib/server-env.ts`
- `scripts/ingest-fred-news.ts`
- `scripts/ingest-market-prices.ts`
- `scripts/ingest-mm-signals.ts`
- `scripts/backfill-futures-all.ts`
- `scripts/ingest-market-prices-daily.ts`

**Verified outcome**

- shared resolver policy matches Prisma fail-closed Accelerate handling
- `fetch-candles` sees the same runtime DB availability policy as Prisma and direct-pool paths
- targeted bulk-write scripts require direct or local DB access instead of generic runtime DB presence

**Verification**

- `npx tsc --noEmit`
- `npx tsx scripts/db-check.ts`
- `rg -n "DATABASE_URL is required|DATABASE_URL required" scripts/ingest-fred-news.ts scripts/ingest-market-prices.ts scripts/ingest-mm-signals.ts scripts/backfill-futures-all.ts scripts/ingest-market-prices-daily.ts`

**Evidence**

- `2026-03-13`: Phase 0A follow-up approved at gatekeeper review and carried forward into this canonical working checklist.

### 0B: Dashboard Feed Recovery Matrix

- [x] Preserve the Phase 0B route-recovery proof and all approved 0B execution blocks.

**Audit artifact**

- [2026-03-13-warbird-phase-0b-dashboard-feed-recovery-matrix.md](./2026-03-13-warbird-phase-0b-dashboard-feed-recovery-matrix.md)

#### 0B-B1: Feed freshness and empty-data response contract

- [x] `/api/gpr`, `/api/pivots/mes`, and `/api/live/mes15m` expose explicit empty, stale, coverage, and runtime-failure metadata without breaking existing route contracts.

**Verification**

- `npx tsc --noEmit`
- `curl -si http://localhost:3000/api/gpr | head -n 20`
- `curl -si http://localhost:3000/api/pivots/mes | head -n 20`
- `curl -si "http://localhost:3000/api/live/mes15m?poll=1&bars=12" | head -n 20`

#### 0B-B2: Setups route hardening at trigger seam

- [x] `/api/setups` exposes deterministic route-state buckets and an explicit legacy trigger seam for later Warbird replacement.

**Verification**

- `npx tsc --noEmit`
- `curl -si http://localhost:3000/api/setups | head -n 30`
- `curl -s http://localhost:3000/api/setups | jq '{status: .meta.status, engine: .meta.engine, setups: (.setups|length), error}'`

**Evidence**

- `meta.engine.seam = "trigger-candidates-adapter"`
- `meta.engine.generator = "generateTriggerCandidates"`
- `meta.engine.backing = "legacy-bhg-adapter"`
- `meta.engine.handoffPhases = ["0C", "0D", "4"]`

#### 0B-B3: Forecast degradation contract

- [x] `/api/forecast` exposes additive route-state metadata for `full-success`, `data-unavailable`, `ai-unavailable`, and `runtime-failure`.

**Verification**

- `npx tsc --noEmit`
- `curl -si "http://localhost:3000/api/forecast?refresh=true" | head -n 30`
- `curl -s "http://localhost:3000/api/forecast?refresh=true" | jq '{status: .meta.status, source: .meta.source, error}'`

#### 0B-B4: Inngest served-surface vs runtime-health split

- [x] `/api/inngest?probe=health` distinguishes route serve health from runtime execution health and exposes served-vs-exported drift.

**Verification**

- `npx tsc --noEmit`
- `curl -si "http://localhost:3000/api/inngest?probe=health" | head -n 30`
- `curl -s "http://localhost:3000/api/inngest?probe=health" | jq`

#### 0B-B5: Upcoming trades cache warm/cold resilience

- [x] `/api/trades/upcoming` exposes deterministic cache-state metadata and non-cacheable stale or failure responses without changing writer ownership.

**Verification**

- `npx tsc --noEmit`
- `curl -si http://localhost:3000/api/trades/upcoming | head -n 30`
- `curl -s http://localhost:3000/api/trades/upcoming | jq '{status: .meta.status, stale: .meta.isStale, age: .meta.cacheAgeSeconds, error}'`

#### 0B-B6: Chart-adjacent AI synthesis shutdown

- [x] The under-chart AI synthesis surface is unmounted in `src/components/MesIntraday/IntelligenceConsole.tsx` while the hook, component, and route remain preserved for later reuse.

**Verification**

- `npx tsc --noEmit`
- static proof in `src/components/MesIntraday/IntelligenceConsole.tsx` that `useAiSynthesis` and `AiSynthesisBillboard` are no longer mounted

#### 0B-B7: MES chart freshness owner-path proof

- [x] `/api/live/mes15m` preserves the chart contract and exposes additive owner-path freshness attribution tied to the authoritative MES 1m writer.

**Verification**

- `npx tsc --noEmit`
- `curl -si "http://localhost:3000/api/live/mes15m?poll=1&bars=12" | head -n 30`
- `curl -s "http://localhost:3000/api/live/mes15m?poll=1&bars=12" | jq`

### 0C: Warbird Engine Skeleton Beside Legacy

- [x] Preserve the additive Warbird engine and recorder scaffolding already landed on `main`.

**Legacy files left in place**

- `src/lib/bhg-engine.ts`
- `src/lib/trigger-candidates.ts`
- `src/lib/bhg-setup-recorder.ts`
- `src/lib/outcome-tracker.ts`
- `scripts/build-bhg-dataset.ts`
- `scripts/bhg-engine.test.ts`
- `scripts/trigger-candidates.test.ts`

**Warbird scaffolding preserved**

- [x] `0C-1` additive bootstrap seam in `src/lib/warbird-engine.ts`
- [x] `0C-2` additive bridge recorder in `src/lib/warbird-setup-recorder.ts`
- [x] `0C-3` Warbird-owned pure helper functions
- [x] `0C-4` Warbird-owned target computation with retained tick-size and minimum-distance rules
- [x] `0C-5` `advanceWarbirdSetupsPure(...)` parity-proof path while exported `advanceWarbirdSetups(...)` remains explicitly delegated

**Verification**

- `npx tsc --noEmit`
- `node --import tsx --test scripts/warbird-engine.test.ts`
- `node --import tsx --test scripts/warbird-setup-recorder.test.ts`

### 0D: Parity Adapter and Comparison Harness

- [x] Run the formal parity diff and report before any caller flip or export flip.

**Inputs**

- same MES `15m` candle window
- same fib result input
- same measured-move input

**Required output**

- setup count diff
- phase transition diff
- target and stop diff
- explicit disposition for every difference: `bug`, `intentional improvement`, or `unresolved`

**Verification**

- `node --import tsx scripts/warbird-parity-report.ts`
- one written parity report linked from this file
- the report names the exact input window used

**Evidence**

- [2026-03-14-warbird-phase-0d-parity-report.md](./2026-03-14-warbird-phase-0d-parity-report.md)

### 0E: Warbird Data Contract

- [x] Complete the explicit logical mapping from legacy BHG surfaces to Warbird runtime names without pretending the DB is already destructively renamed.

**Current BHG-named surfaces to map or retire**

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
- `datasets/autogluon/warbird_setups.csv` exists
- setup-dataset builders and trainers now point at `datasets/autogluon/warbird_setups.csv`
- `scripts/build-lean-dataset.ts` still queries physical DB table `bhg_setups` for rolling setup and outcome features
- physical DB truth is still `bhg_setups` and `BhgPhase`

**Verification**

- `rg -n "Bhg|bhg_|GO_FIRED" prisma/schema.prisma src/lib scripts src/app/api/setups src/inngest indicators`
- `node --import tsx --test scripts/warbird-setup-recorder.test.ts`

**Evidence**

- [2026-03-14-warbird-phase-0e-data-contract.md](./2026-03-14-warbird-phase-0e-data-contract.md)

---

## Active Phase Status

- [x] Phase 1: Canonical v1 contract lock
- [ ] Phase 2: Data foundation and feature reconciliation. Complete except for documented external blockers: macro raw-companion backfill requirements, empty `geopolitical_risk_1d` history in the connected DB, and missing GARCH feature columns. This is Phase-3-authorizable once Kirk approves moving forward.
- [ ] Phase 3: Core forecaster and GARCH
- [ ] Phase 4: Inference contract and consumer migration
- [ ] Phase 5: Backfills, transition, and retirement

---

## Phase 1: Canonical v1 Contract Lock

**Primary surfaces**

- this checklist
- `AGENTS.md`
- `prisma/schema.prisma`
- `src/lib/bhg-engine.ts`
- `src/lib/warbird-engine.ts`
- `src/lib/trade-features.ts`
- `src/inngest/functions/compute-signal.ts`
- `src/lib/composite-score.ts`
- `src/lib/correlation-filter.ts`

**Checklist**

- [x] Replace the old Pine-engine and replay-first phase language with the canonical Warbird v1 scope everywhere this working plan drives execution. Verified in this file via the active Phase 1-5 layout, the deferred register, and the explicit out-of-scope gate for Pine or TradingView buildout.
- [x] Lock naming: Warbird is the engine, Rabid Raccoon is the platform, and BHG survives only as trading-method terminology. Verified below in the Phase 1 contract lock evidence and in the locked decisions carried forward.
- [x] Lock the four-layer architecture: daily `200d` MA shadow, `4H` structure-only confirmation, `1H` fib geometry plus core forecaster, and `15M` rule-based entry confirmation. Verified below in the Phase 1 contract lock evidence and in the locked decisions carried forward.
- [x] Lock the conviction matrix as rule-based v1 behavior. Verified below in the Phase 1 contract lock evidence.
- [x] Lock volume as first-class across trigger validation, core-forecaster context, and runner-eligibility rules. Verified below in the Phase 1 contract lock evidence and in the locked decisions carried forward.
- [x] Lock the regime anchor at `2025-01-20` with dual-lookback and raw-companion design rules. Verified below in the Phase 1 contract lock evidence and in the locked decisions carried forward.
- [x] Lock the full label taxonomy: six regression targets live in v1; setup-outcome labels are computed and stored, but their ML scorer is deferred. Verified below in the Phase 1 contract lock evidence, the deferred register, and the locked decisions carried forward.
- [x] Mark anything outside this contract as `deferred`, `legacy drift`, or `archive candidate`, not active v1 scope. Verified by the deferred register, drift surface inventory, blocker register, and backfill dependency register in this file.

**Outputs**

- explicit contract text for naming, architecture, volume, regime, and labels
- explicit v1 versus deferred boundary for every formerly ambiguous Warbird surface
- no Pine or TradingView buildout left inside the active v1 lane

### Phase 1 Contract Lock Evidence

| Contract item | Verified lock carried in this checklist |
|---|---|
| Naming | Warbird = engine, Rabid Raccoon = platform, BHG survives only as trading-method terminology during additive transition |
| Four-layer architecture | Daily `200d` MA shadow -> `4H` structure-only confirmation -> `1H` fib geometry plus core forecaster -> `15M` rule-based entry confirmation |
| Conviction matrix | `MAXIMUM` when daily + `4H` + `1H` + `15M` align; `READY` / `PATIENT` when higher layers align but lower layers are pending; `MODERATE` when daily is neutral; `LOW` counter-trend with T1-only / no-runner penalty; `NO_TRADE` when daily is against and other layers disagree |
| Volume role | Volume remains first-class in trigger validation, core-forecaster context, and runner eligibility; post-entry `micropullback_vol_pattern`, `vol_profile_at_tp1`, and `vol_trend_post_trigger` stay out of the v1 core forecaster |
| Regime contract | `2025-01-20` is the regime anchor; v1 uses two full years of data plus regime-sensitive features, dual-lookback logic, and raw companion columns without clipping |
| Label taxonomy | Live v1 regression labels are `target_price_1h`, `target_price_4h`, `target_mae_1h`, `target_mae_4h`, `target_mfe_1h`, `target_mfe_4h`; setup-outcome labels remain computed and stored, but their dedicated ML scorer is deferred |
| Out-of-scope classification | `15M` ML, setup scorer ML, Monte Carlo, pinball loss, FinBERT, TabM/RealMLP, Pine/TradingView buildout, and non-MES expansion are all explicitly parked outside active v1 execution |

**Verification**

- `rg -n "Pine|TradingView|15M ML|Monte Carlo|pinball|FinBERT|setup outcome scorer" docs/plans/2026-03-13-warbird-master-tasklist.md`
- `rg -n "Warbird v1|200d|4H|1H|15M|conviction|REGIME_START|target_price_1h|target_mae_1h|target_mfe_1h" docs/plans/2026-03-13-warbird-master-tasklist.md`

---

## Phase 2: Data Foundation and Feature Reconciliation

**Primary surfaces**

- `scripts/build-lean-dataset.ts`
- `scripts/build-1m-dataset.ts`
- `scripts/build-15m-dataset.ts`
- `scripts/build-bhg-dataset.ts`
- `src/lib/trade-features.ts`
- `src/lib/composite-score.ts`
- `src/inngest/functions/compute-signal.ts`

### Dataset Surface Classification

| Surface | Timeframe | Status | Warbird v1 role |
|---|---|---|---|
| `build-lean-dataset.ts` | `1H` | Active | Canonical 1H core-forecaster dataset builder |
| `build-15m-dataset.ts` | `15M` | Deferred | Supporting surface only for future 15M model; not v1 active training scope |
| `build-bhg-dataset.ts` | Setup-level | Deferred / drift | Survives only as a legacy-named setup-dataset path to be renamed or parked for later setup scorer work |
| `build-1m-dataset.ts` | `1M` | Evaluate | Possible micro-pullback, volume-pattern, or analysis support surface; do not treat as dead by assumption |

**Checklist**

- [x] Set `scripts/build-lean-dataset.ts` as the canonical `1H` Warbird dataset builder. Verified by the dataset surface classification in this checklist, the March 14 spec Section 10, and the script's default `--timeframe=1h` path.
- [x] Inventory the current `1H` column set against canonical feature families and write the gap list directly into this checklist. Verified below in the current `1H` gap inventory.
- [x] Carry forward raw FRED integration as already-implemented state.
- [x] Add or verify daily-context, derived-FRED, cross-asset, calendar, and news-layer features in the canonical `1H` lane. Verified complete for the current builder/on-disk dataset on `2026-03-14`: daily-context fields `price_vs_200d_ma`, `distance_from_200d_ma_pct`, `slope_200d_ma`, `sessions_above_below_200d`, `daily_ret`, and `daily_range_vs_avg`; cross-asset alignment; calendar/news features including `hours_since_last_high_impact`; and the derived-FRED alias set `yield_curve_2s10s`, `yield_curve_10s30s`, `real_rate_5y`, `credit_spread_hy_ig`, `vix_term_structure`, `fed_liquidity_proxy`, and `oil_momentum_5d`.
- [ ] Add surprise z-score triples and raw companions once macro backfill exists. Blocked: surprise z-score proxies are present on disk, but the raw companion columns still depend on the canonical macro backfill lane for official actual / forecast / surprise history.
- [ ] Add trade-feedback, GPR, TrumpEffect, GARCH, and regime-context feature groups to the canonical dataset lane. Blocked by two remaining gaps only: the connected DB has zero `geopolitical_risk_1d` rows, so `gpr_level` / `gpr_change_1d` columns are present but unpopulated, and GARCH feature columns are still not implemented in `build-lean-dataset.ts`. Verified complete on `2026-03-14` for TrumpEffect and trade-feedback output fields in both the probe build and refreshed on-disk `1H` dataset.
- [x] Audit every live feature in `src/lib/trade-features.ts` into exactly one bucket. Verified below in the live-feature bucket audit.
  - belongs in the training dataset
  - remains a post-model rule-based adjustment
  - is redundant live-path drift to remove
- [x] Re-evaluate the `1M` dataset as a supporting micro-pullback or analysis surface instead of treating it as dead by assumption. Verified by `scripts/build-1m-dataset.ts`, which already carries macro, GPR, Trump, calendar, news, and multi-horizon targets and therefore remains a support or analysis surface rather than a dead lane.
- [x] Keep `15M` dataset work and setup-dataset enrichment out of core-v1 training scope unless the canonical spec names them as supporting or deferred surfaces. Verified by the dataset surface classification table and the deferred register in this checklist.

**Outputs**

- explicit `1H` feature-family gap list
- train-serve classification for every live feature that currently bypasses training
- explicit keep / support / defer / archive classification for `1M`, `15M`, and setup-level dataset surfaces

### Current `1H` Gap Inventory

**Verified sources**

- On-disk dataset: `datasets/autogluon/mes_lean_fred_indexes_2020plus.csv` (`206` columns after the `2026-03-14` refresh)
- Source builder: `scripts/build-lean-dataset.ts`
- Probe command: `node --import tsx scripts/build-lean-dataset.ts --days-back=30 --out=datasets/tmp/warbird_phase2_probe.csv`
- Probe result: runs clean on `2026-03-14` and resolves the additive setup-history table to `warbird_setups`

| Canonical family | On-disk `1H` CSV state | Current source-builder state | Resolution state |
|---|---|---|---|
| Daily context | On disk after the `2026-03-14` refresh: `price_vs_200d_ma`, `distance_from_200d_ma_pct`, `slope_200d_ma`, `sessions_above_below_200d`, `daily_ret`, and `daily_range_vs_avg` are all present | Source builder now derives the trailing-200-session shadow fields from `mkt_futures_mes_1d`, computes `slope_200d_ma` as the 5-session change in the 200d MA, counts consecutive `1H` bars on the current side of the 200d MA, and computes `daily_range_vs_avg` as the running intraday range divided by the prior 20-session average daily range | Verified |
| Derived FRED | On disk after the `2026-03-14` refresh: `yield_curve_2s10s`, `yield_curve_10s30s`, `real_rate_5y`, `credit_spread_hy_ig`, `vix_term_structure`, `fed_liquidity_proxy`, and `oil_momentum_5d` now exist alongside prior fields such as `vix_percentile_20d`, `real_rate_10y`, and `dollar_momentum_5d` | Source builder now loads verified raw inputs `DGS5`, `DFII5`, and `VXVCLS` and emits the canonical alias set end-to-end | Verified |
| Cross-asset | Present on disk: `mes_ret_1h`, `nq_ret_1h`, `zn_ret_1h`, `cl_ret_1h`, `e6_ret_1h`, `j6_ret_1h`, `ng_ret_1h` | Source builder aligns cross-asset `1H` bars from `mkt_futures_1h` | Verified |
| Calendar + news | Present on disk after the `2026-03-14` refresh: `is_fomc_day`, `is_high_impact_day`, `hours_to_next_high_impact`, `hours_since_last_high_impact`, `econ_news_volume_7d`, `policy_news_volume_7d`, and `news_total_volume_7d` | Source builder computes both forward and backward high-impact proximity plus the existing calendar/news rolling counts | Verified |
| Surprise features | Present on disk: `nfp_release_z`, `cpi_release_z`, `retail_sales_release_z`, `ppi_release_z`, `gdp_release_z`, `claims_release_z`, `econ_surprise_index` | Source builder computes the z-score proxies from lagged event-signal lookups | Verified for z-scores only; raw companions blocked |
| Risk + feedback | Present on disk after the `2026-03-14` refresh: `trump_eo_count_7d`, `trump_tariff_flag`, `trump_policy_velocity_7d`, legacy-named trade-feedback fields such as `bhg_tp1_hit_rate_7d` / `bhg_win_rate_7d`, and regime proxies `vol_regime` / `corr_regime_count`; `gpr_level` / `gpr_change_1d` columns exist but the connected DB currently has zero source rows, and no GARCH fields exist yet | Source builder now resolves `warbird_setups` cleanly and emits the additive trade-feedback / TrumpEffect columns; GPR remains source-empty and GARCH is still absent in source | Blocked |

### Live-Feature Bucket Audit

- Training-dataset bucket: `minutesToNextEvent`, `minutesSinceEvent`, `vixLevel`, `vixPercentile`, `vixIntradayRange`, `gprLevel`, `gprChange1d`, `trumpEoCount7d`, `trumpTariffFlag`, `trumpPolicyVelocity7d`, `federalRegisterVelocity7d`, `epuTrumpPremium`, `regime`, `sqzMom`, `sqzState`, `wvfValue`, `wvfPercentile`, `macdAboveZero`, `macdAboveSignal`, `macdHistAboveZero`, `newsVolume24h`, `policyNewsVolume24h`, `newsVolume1h`, `newsVelocity`, `breakingNewsFlag`, `rvol`, `rvolSession`
- Post-model rule-based adjustment bucket: `fibRatio`, `goType`, `hookQuality`, `measuredMoveAligned`, `measuredMoveQuality`, `stopDistancePts`, `rrRatio`, `riskGrade`, `eventPhase`, `confidenceAdjustment`, `compositeAlignment`, `isAligned`, `acceptanceState`, `acceptanceScore`, `sweepFlag`, `bullTrapFlag`, `bearTrapFlag`, `whipsawFlag`, `fakeoutFlag`, `blockerDensity`, `openSpaceRatio`, `wickQuality`, `bodyQuality`, `volumeState`, `vwap`, `priceVsVwap`, `vwapBand`, `poc`, `priceVsPoc`, `inValueArea`, `volumeConfirmation`, `pocSlope`, `paceAcceleration`
- Redundant live-path drift to remove or decompose before model use: `themeScores`, `correlationDetails`, `activeCorrelationSymbols`, `alignedCorrelationSymbols`, `divergingCorrelationSymbols`, `ignoredCorrelationSymbols`

**Verification**

- `node --import tsx scripts/build-lean-dataset.ts --days-back=30 --force --out=datasets/tmp/warbird_phase2_probe.csv`
- `node --import tsx scripts/build-lean-dataset.ts --force`
- `npx tsc --noEmit --pretty false`
- `python3 - <<'PY'` header checks for `datasets/tmp/warbird_phase2_probe.csv` and `datasets/autogluon/mes_lean_fred_indexes_2020plus.csv` confirming `206` columns plus `price_vs_200d_ma`, `distance_from_200d_ma_pct`, `slope_200d_ma`, `sessions_above_below_200d`, `daily_ret`, `daily_range_vs_avg`, `yield_curve_2s10s`, `yield_curve_10s30s`, `real_rate_5y`, `credit_spread_hy_ig`, `vix_term_structure`, `fed_liquidity_proxy`, `oil_momentum_5d`, `hours_since_last_high_impact`, `gpr_level`, `trump_eo_count_7d`, and `bhg_win_rate_7d`
- `rg -n "surprise|econ_surprise|gpr|trump|vol_ratio|vol_expansion_trigger|vol_relative_to_session|micropullback_vol_pattern|vol_profile_at_tp1|vol_trend_post_trigger" scripts/build-lean-dataset.ts scripts/build-1m-dataset.ts src/lib/trade-features.ts`
- `rg -n "bhg_setups_count|warbird_setups|rowHash|knowledgeTime|ingestedAt" scripts/build-lean-dataset.ts scripts/build-bhg-dataset.ts`

---

## Phase 3: Core Forecaster and GARCH

**Primary surfaces**

- `scripts/train-warbird.py`
- `scripts/train-core-forecaster.py`
- `scripts/predict.py`
- `scripts/train-fib-scorer.py`
- `scripts/build-lean-dataset.ts`
- `src/app/api/ml-forecast/route.ts`
- `public/ml-predictions.json`

**Checklist**

- [ ] Refactor `scripts/train-warbird.py` to the canonical v1 contract.
- [ ] Lock one model family as six sequential `TabularPredictor` artifacts:
  - `target_price_1h`
  - `target_price_4h`
  - `target_mae_1h`
  - `target_mae_4h`
  - `target_mfe_1h`
  - `target_mfe_4h`
- [ ] Keep all six predictors on the same canonical `1H` dataset and the same locked AutoGluon config; do not describe this as one multi-output model.
- [ ] Sync the training config to:
  - `presets='best_quality'`
  - `num_bag_folds=5`
  - `num_stack_levels=1`
  - `dynamic_stacking='auto'`
  - `excluded_model_types=['KNN', 'FASTAI', 'RF']`
  - `ag_args_ensemble.fold_fitting_strategy='sequential_local'`
- [ ] Split GARCH into a reusable engine that serves both training features and inference zones.
- [ ] Run the price-space versus return-space ablation on identical folds and features; keep inference output in price-space regardless of the winning internal representation.
- [ ] Reclassify IC ranking plus hierarchical cluster dedup as an existing repo approach to validate, not a canonical contract requirement.
- [ ] Reserve SHAP or other feature-importance reporting for validation and analysis only; do not turn feature-selection mechanics into contract-level doctrine.
- [ ] Classify `scripts/train-core-forecaster.py`, `scripts/predict.py`, and `scripts/train-fib-scorer.py` as drift or deferred surfaces that must be aligned, archived, or explicitly parked.
- [ ] Keep setup-outcome scorer ML, Monte Carlo, and pinball-loss experimentation out of the active v1 trainer lane.

**Outputs**

- one canonical v1 trainer path
- one explicit ablation path for returns vs price-level internal targets
- reusable GARCH engine boundary for both training and inference
- explicit disposition for legacy or conflicting trainer/export scripts

**Verification**

- `python3 -m py_compile scripts/train-warbird.py scripts/train-core-forecaster.py scripts/predict.py scripts/train-fib-scorer.py`
- `rg -n "num_stack_levels|excluded_model_types|target_price_1h|target_price_4h|target_mae_1h|target_mae_4h|target_mfe_1h|target_mfe_4h|1d|1w" scripts/train-warbird.py`
- `rg -n "TabularPredictor|classify|volnorm|core_forecaster|prob_up_1h|prob_up_4h|prob_up_1d|prob_up_1w" scripts/train-core-forecaster.py scripts/predict.py`

---

## Phase 4: Inference Contract and Consumer Migration

**Status**

- Held. Do not start this phase until Phase 3 produces real Warbird inference artifacts.
- Do not emit a partial or mostly-null `WarbirdSignal` object from the legacy directional export lane.
- The existing `public/ml-predictions.json`, `/api/ml-forecast`, and `MLForecastTile` payload contract stays untouched until there is a real Warbird inference lane to transport.

**Primary surfaces**

- `src/app/api/ml-forecast/route.ts`
- `src/components/MesIntraday/MLForecastTile.tsx`
- `public/ml-predictions.json`
- `src/app/api/setups/route.ts`
- `src/app/api/forecast/route.ts`
- `src/app/api/trades/upcoming/route.ts`

**Checklist**

- [x] Hold this phase until Phase 3 produces real Warbird inference artifacts; do not start consumer or transport migration early.
- [ ] Lock `WarbirdSignal v1.0` as the versioned inference contract.
- [ ] Move `public/ml-predictions.json` toward a versioned Warbird payload without breaking current readers during transition.
- [ ] Preserve existing fields during payload migration; make every new field additive only; use `version` to gate consumer migration.
- [ ] Treat backward compatibility as absolute during payload migration; no existing consumer may break as the new contract lands.
- [ ] Update `src/app/api/ml-forecast/route.ts` to serve the additive versioned payload while retaining current freshness and staleness semantics.
- [ ] Update `src/components/MesIntraday/MLForecastTile.tsx` to consume the additive contract without breaking current behavior.
- [ ] Keep the BHG-to-Warbird runtime and storage bridge additive until parity, consumer, and migration gates pass.
- [ ] Preserve the frozen MES chart frontend contract absolutely; no visible chart behavior changes enter this phase.

**Outputs**

- explicit hold boundary: legacy payload remains the only active transport until real Warbird inference exists
- versioned `WarbirdSignal` payload contract
- additive file-backed export transition plan
- explicit consumer migration path for route and tile readers
- no destructive payload break during migration

**Verification**

- `python3 - <<'PY'\nimport json, pathlib\nobj=json.loads(pathlib.Path('public/ml-predictions.json').read_text())\nprint(sorted(obj.keys()))\nprint(sorted((obj.get('predictions') or [{}])[0].keys()))\nPY`
- `curl -si "http://localhost:3000/api/ml-forecast?rows=1" | head -n 40`
- `rg -n "prob_up_|direction_|confidence_|version|WarbirdSignal|ml-predictions" src/app/api/ml-forecast/route.ts src/components/MesIntraday/MLForecastTile.tsx public/ml-predictions.json`

---

## Phase 5: Backfills, Transition, and Retirement

**Primary surfaces**

- `prisma/schema.prisma`
- `scripts/build-regime-lookup.ts`
- `scripts/build-bhg-dataset.ts`
- `scripts/train-fib-scorer.py`
- `src/lib/bhg-engine.ts`
- `src/lib/bhg-setup-recorder.ts`
- `src/lib/outcome-tracker.ts`

**Checklist**

- [ ] Complete the additive BHG -> Warbird naming transition plan without destructive DB renames.
- [ ] Track backfill dependencies explicitly:
  - FRED releases
  - Trading Economics surprise history
  - news content
  - Fed statements
  - GPR history
  - TrumpEffect history
- [ ] Keep the deferred register explicit for `15M` ML, setup-outcome scorer ML, Monte Carlo, pinball loss, FinBERT, RealMLP or TabM additions, HPO, GPU-only presets, and non-MES expansion.
- [ ] Retire legacy BHG runtime and training surfaces only after verified Warbird replacements exist, parity is written, and consumer migration is proven non-breaking.
- [ ] Keep approved additive scaffolding acknowledged as foundation, not rework.

**Outputs**

- additive rename map
- backfill dependency queue
- explicit retirement criteria for every legacy BHG surface
- no destructive cleanup before proof

**Verification**

- `rg -n "Bhg|bhg_|Warbird|warbird_" prisma/schema.prisma src/lib scripts src/app public`
- `rg -n "Trading Economics|FRED|GPR|TrumpEffect|Fed|news" docs/plans/2026-03-13-warbird-master-tasklist.md`

---

## Mismatch Register

- [x] **Mismatch 1: Price levels vs returns**  
  Status: resolved to ablation.  
  Action: run price-space vs return-space ablation on identical folds and features; inference remains price-space regardless.

- [x] **Mismatch 2: Fold count**  
  Status: resolved to `5` folds.  
  Action: hold `8` folds as a future Warbird v2 experiment only.

- [ ] **Mismatch 3: Train-serve feature gap**  
  Status: active.  
  Action: classify every live feature in `src/lib/trade-features.ts` into training-feature, post-model rule, or redundant drift.

- [ ] **Mismatch 4: BHG -> Warbird naming transition**  
  Status: active additive transition.  
  Action: complete rename planning without destructive DB renames; keep bridge mappings explicit until validated.

- [ ] **Mismatch 5: 1m dataset classification**  
  Status: active.  
  Action: re-evaluate `scripts/build-1m-dataset.ts` with an accurate description and explicit keep or park decision.

- [ ] **Mismatch 6: AG config drift**  
  Status: active.  
  Action: sync `scripts/train-warbird.py` to the canonical config before any v1 training run.

- [ ] **Mismatch 7: Model family implementation drift**  
  Status: active.  
  Action: reduce the active trainer to the v1 one-family / six-predictor contract and park broader model expansion outside v1.

---

## Blocking Item Register

- [x] **Blocking item 1: Geopolitical feature validity gate**  
  Resolved: risk features enter as model inputs with regime-stability testing.

- [x] **Blocking item 2: Warbird-as-feature contract**  
  Resolved: AutoGluon learns interaction weights; Warbird risk inputs are features, not filters.

- [x] **Blocking item 3: Sequential training and memory guardrails**  
  Resolved: `sequential_local` fold fitting and sequential training on Apple Silicon are locked.

- [ ] **Blocking item 4: Numeric shadow promotion thresholds**  
  Open: define minimum sample window, minimum time window, and quantitative MAE drift threshold from baseline proof.  
  Guardrail: do not invent values in this lane.

- [x] **Blocking item 5: GARCH spec lock**  
  Resolved: GJR-GARCH, Student-t innovations, regime-anchored expanding window, both raw sigma and ratio carried through ablation.

---

## Drift Surface Inventory

- [ ] `prisma/schema.prisma` still exposes `BhgPhase` and `bhg_setups`.
- [ ] `src/lib/bhg-engine.ts` remains a live legacy engine surface.
- [ ] `src/lib/bhg-setup-recorder.ts` remains a live legacy recorder surface.
- [ ] `src/lib/trigger-candidates.ts` still anchors `/api/setups` through the legacy seam.
- [ ] `src/lib/outcome-tracker.ts` still writes legacy outcome phase truth.
- [ ] `scripts/build-bhg-dataset.ts` still carries legacy builder naming even though it now writes `datasets/autogluon/warbird_setups.csv`.
- [ ] `scripts/build-regime-lookup.ts` now reads `datasets/autogluon/warbird_setups.csv` but still belongs to the supporting or deferred setup-outcome lane.
- [ ] `scripts/train-fib-scorer.py` still trains the deferred setup-outcome scorer lane, now against `datasets/autogluon/warbird_setups.csv`.
- [ ] `scripts/train-warbird.py` is only partially aligned and still conflicts with the full locked v1 data and artifact contract.
- [ ] `scripts/train-core-forecaster.py` still represents an older core-forecaster path that must be classified.
- [ ] `scripts/predict.py` still writes the legacy directional export shape.
- [ ] `src/app/api/ml-forecast/route.ts` still types the legacy directional payload.
- [ ] `src/components/MesIntraday/MLForecastTile.tsx` still expects the legacy directional payload.
- [ ] `public/ml-predictions.json` is still not a versioned `WarbirdSignal` export and must remain unchanged until real Phase 3 inference artifacts exist.

---

## Backfill Dependency Register

| Backfill | Unlocks | Priority | Status |
|---|---|---|---|
| `backfill-fred-releases.ts` | official FRED release dates and event timing features | High | Pending |
| `backfill-trading-economics.ts` | surprise z-scores and surprise momentum features | Critical | Pending |
| `backfill-news-content.ts` | deeper news-layer features and future FinBERT preparation | Medium | Pending |
| `backfill-fed-statements.ts` | Fed communication features | Medium | Pending |
| GPR history backfill | GPR risk features | Required | Pending |
| TrumpEffect history backfill | TrumpEffect policy features | Required | Pending |

---

## Locked Decisions Carried Forward

- [x] Warbird is the engine; Rabid Raccoon is the platform.
- [x] BHG -> Warbird rename is additive during transition.
- [x] Volume is first-class for T2 and runner decisions.
- [x] Warbird risk inputs are features, not filters.
- [x] GARCH is GJR-GARCH with Student-t innovations on a regime-anchored expanding window.
- [x] Both GARCH representations remain through ablation until evidence says otherwise.
- [x] Surprise z-scores are the highest ROI macro feature family.
- [x] The daily `200d` MA is the directional shadow and is required.
- [x] `4H` is trend and structure only; it does not own fib geometry.
- [x] `1H` is where fibs live and where trades are identified.
- [x] `15M` is rule-based entry confirmation in v1.
- [x] The regime anchor is `2025-01-20`.
- [x] Training uses two full years of data with regime-sensitive features anchored from `2025-01-20`.
- [x] Warbird v1 is one model family made of six target-specific predictors trained sequentially on the same canonical `1H` dataset.
- [x] `15M` ML, setup scorer ML, Monte Carlo, and pinball experimentation are deferred beyond v1.
- [x] Unprecedented-market rules require dual-lookback features, raw companion columns, and no clipping.
- [x] Fold count is locked at `5`.
- [x] Price levels vs returns is an ablation question; inference remains price-space.
- [x] Post-entry volume fields are trade-management features, not pre-entry core-forecaster inputs.

---

## Deferred Register

- [x] `15M` ML model is deferred to Warbird v2.
- [x] Setup-outcome scorer ML model is deferred to Warbird v3.
- [x] Monte Carlo simulation is deferred beyond v1.
- [x] Pinball loss and quantile-regression experiments are deferred beyond v1.
- [x] FinBERT sentiment scoring is deferred beyond v1.
- [x] RealMLP and TabM additions are deferred beyond v1.
- [x] Hyperparameter optimization is deferred beyond v1.
- [x] GPU-only extreme-quality preset work is out of scope on Apple Silicon.
- [x] Per-symbol expansion beyond MES is out of scope for Warbird v1.
- [x] Pine or TradingView indicator buildout is not an active Warbird v1 execution lane in this checklist.

---

## Acceptance Gates

- [ ] **Coverage gate:** this checklist must continue to map the full canonical spec, all seven mismatches, the blocker table, the backfill table, the decision log, and the out-of-scope register.
- [ ] **Scope gate:** no Pine buildout, no TradingView buildout, no `15M` ML, no setup-outcome scorer ML, no Monte Carlo, no pinball-loss rollout, and no destructive payload or DB migration may enter active v1 execution scope.
- [ ] **Reality gate:** the checklist must keep naming the actual drift surfaces present in repo reality and must not pretend they are already reconciled.
- [ ] **Verification gate:** route probes, `tsc`, Warbird tests, dataset proofs, trainer preflights, parity proof, and payload-compatibility proof remain attached to the relevant phases and must pass before any caller or archive flip.

---

## Defaults

- [x] This working plan replaces the current master tasklist instead of creating a second competing tracker.
- [x] Completed Phase 0 evidence stays if still accurate; obsolete active scope is replaced.
- [x] The March 14 canonical spec remains the only scope source.
- [x] Nothing contradictory is left floating: every non-canonical surface is classified as active, blocked, deferred, legacy drift, or archive candidate.

---

## Ready Queue

1. Execute Phase 1 against the canonical v1 contract and current repo drift surfaces.
2. Execute Phase 2 with the canonical `1H` dataset gap inventory and train-serve reconciliation.
3. Execute Phase 3 to align the active trainer and GARCH boundaries to v1.
4. Execute Phase 4 only after the contract and compatibility path are explicit.
5. Execute Phase 5 only after parity, consumer migration, and replacement proof exist.

---

## Change Log

- `2026-03-14`: rewrote the master tasklist in place as the canonical Warbird working checklist, using the March 14 canonical spec as the sole scope authority while preserving approved Phase 0 evidence and additive scaffolding.
- `2026-03-14`: closed `0E` by adding [2026-03-14-warbird-phase-0e-data-contract.md](./2026-03-14-warbird-phase-0e-data-contract.md), which maps the additive Warbird runtime surface to the current physical `bhg_setups` / `BhgPhase` storage, the canonical setup ID contract, and the Warbird setup-dataset path.
- `2026-03-14`: closed `0D` by adding `scripts/warbird-parity-report.ts` plus [2026-03-14-warbird-phase-0d-parity-report.md](./2026-03-14-warbird-phase-0d-parity-report.md); delegated Warbird, pure Warbird, and legacy BHG matched exactly on the pinned 12-bar fixture with zero setup-count, phase, stop, or target diffs.
- `2026-03-13`: continued `0C` fifth slice by adding full non-delegating `advanceWarbirdSetupsPure(...)` in `src/lib/warbird-engine.ts` using Warbird-owned helpers and targets, while keeping exported `advanceWarbirdSetups(...)` explicitly delegated to legacy.
- `2026-03-13`: continued `0C` fourth slice by adding Warbird-owned `computeWarbirdTargets(...)` with retained tick-size rounding and tick-based minimum-distance guard, plus explicit same-as-legacy parity tests.
- `2026-03-13`: continued `0C` third slice by adding first independent pure Warbird state-machine helpers in `src/lib/warbird-engine.ts` while keeping exported advancement delegated to legacy.
- `2026-03-13`: continued `0C` second slice by adding compile-safe `src/lib/warbird-setup-recorder.ts` and `scripts/warbird-setup-recorder.test.ts`; Warbird recorder maps explicitly to physical legacy `bhg_setups` and `BhgPhase` with no caller flip.
- `2026-03-13`: started `0C` first slice by adding compile-safe `src/lib/warbird-engine.ts` and `scripts/warbird-engine.test.ts`; bootstrap mode is explicit `legacy-bhg-delegation` with no caller flip.
- `2026-03-13`: executed `0B-B7` MES chart freshness owner-path proof by extending `/api/live/mes15m` metadata with explicit owner-path attribution and shared MES `1m` freshness telemetry.
- `2026-03-13`: executed `0B-B5` upcoming-trades cache warm/cold resilience with additive `meta` states, explicit freshness metadata, and `no-store` headers for non-success states.
- `2026-03-13`: executed `0B-B4` Inngest served-surface vs runtime-health split by adding probe-safe `GET /api/inngest?probe=health` metadata while preserving normal Inngest `GET/PUT/POST` serve behavior.
- `2026-03-13`: executed `0B-B3` forecast degradation contract with deterministic additive `meta` states and explicit data-vs-AI source classification in `/api/forecast`.
- `2026-03-13`: executed `0B-B2` setups route hardening with deterministic route-state buckets, explicit trigger-seam metadata, and non-breaking additive `meta` contract updates in `/api/setups`.
- `2026-03-13`: executed `0B-B1` feed freshness and empty-data response contract for `/api/gpr`, `/api/pivots/mes`, and `/api/live/mes15m` with additive metadata and deterministic empty-source/runtime-failure states.
- `2026-03-13`: completed `0B-B6` chart-adjacent AI synthesis shutdown by unmounting the under-chart AI synthesis path in `src/components/MesIntraday/IntelligenceConsole.tsx` while preserving `AiSynthesisBillboard`, `useAiSynthesis`, and `/api/ai/synthesis` for later reuse.
