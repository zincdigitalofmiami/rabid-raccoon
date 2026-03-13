# Warbird Model Readiness Audit
**Date:** 2026-03-11
**Author:** Claude (read-only audit — no code changes made)
**Scope:** End-to-end Warbird lifecycle from training through UI consumption
**Operating model:** Cloud DB + cloud runtime (Next.js/Inngest); local machine for training/scripts

---

## Current State Wiring Map

### Training pipeline (local machine)

```
scripts/build-lean-dataset.ts   (3,187 lines)
  ├── Source: cloud DB (DIRECT_URL → db.prisma.io:5432)
  ├── MES technicals: 22 columns (OHLCV, RSI, Stochastic, MACD, ranges, lags)
  ├── FRED series: 34 columns (lean set — VIX, yields, rates, FX, commodities, labor, credit, EPU)
  ├── Cross-asset technicals: 6 symbols × 6 cols = 36 raw → ~41 net
  │     NQ, ZN, CL, 6E, 6J, NG  ← only 6; AGENTS.md specifies all 63 DB symbols
  ├── Event flags: NFP, CPI, PPI, Retail, GDP, Claims (1-day lag)
  └── Output: datasets/autogluon/mes_lean_fred_indexes_2020plus.csv  (~66 columns total)
                                                                     ↑ TRAINING CONTRACT MISMATCH

scripts/train-warbird.py   (705 lines)
  ├── Reads: datasets/autogluon/mes_lean_fred_indexes_2020plus.csv
  ├── Targets per horizon (one-step lookahead guard confirmed):
  │     target_price_{h} = (close[i+h] - close[i]) / close[i]
  │     target_mae_{h}   = (min(future) - close[i]) / close[i]   future = close[i+1 : i+h+1]
  │     target_mfe_{h}   = (max(future) - close[i]) / close[i]
  ├── Walk-forward CV with purge/embargo (Lopez de Prado):
  │     purge  = (h_bars - 1) + 24      e.g. 1h: 25 rows, 1d: 47 rows
  │     embargo = purge × 2             e.g. 1h: 50 rows, 1d: 94 rows
  │     total gap min: 75 rows (1h) → 141 rows (1d)
  ├── Per-fold feature selection: IC ranking → cluster dedup |r|>0.85 → top 30
  ├── AutoGluon TabularPredictor, regression, MAE metric
  │     presets=best_quality, num_bag_folds=5, num_stack_levels=2
  │     fold_fitting_strategy=sequential_local, seed=42
  │     price time_limit=14400s, MAE/MFE time_limit=7200s
  ├── GARCH(1,1) + 10K Monte Carlo paths (fallback: EWMA — silent, unlogged)
  └── Output: models/warbird/{1h,4h,1d,1w}/{price,mae,mfe}/fold_{0..4}/
                predictor.pkl + fold_meta.json (features, metrics, purge, embargo)
              models/warbird/{horizon}/oof_predictions.csv
              models/reports/warbird_training_summary.json

```

### Serving / inference (currently: v2.1 binary classifier — NOT Warbird)

```
scripts/predict.py   (v2.1 — binary classification, UP/DOWN)
  ├── Reads: datasets/autogluon/mes_lean_fred_indexes_2020plus.csv (last N rows)
  ├── Loads: models/core_forecaster/{1h,4h,1d,1w}/fold_{k}/  ← OLD model path
  ├── Calibration: {horizon}/calibrator.pkl (isotonic or Platt)
  ├── Output: public/ml-predictions.json  (static file, manual execution)
  └── NEVER writes to mes_model_registry table   ← ORPHANED SCHEMA

src/app/api/ml-forecast/route.ts   (113 lines)
  ├── Reads: process.cwd()/public/ml-predictions.json
  ├── Stale flag: age > 120 min
  ├── Returns: { latest, predictions[], meta, stale, age_minutes }
  └── Cache-Control: s-maxage=60, stale-while-revalidate=300

src/hooks/useForecast.ts → /api/forecast (AI narrative, NOT Warbird predictions)
  └── /api/forecast calls OpenRouter for AI-generated directional forecast
       separate from ML predictions; Central Time window gating

src/components/MesIntraday/MLForecastTile.tsx   (261 lines)
  ├── Fetches /api/ml-forecast?rows=1
  ├── Shows P(UP) bars for 1H/4H/1D/1W + calibration badge
  └── Stale indicator when age > 120 min
```

### Trigger / decision engine (still wired to legacy BhgSetup)

```
src/inngest/functions/compute-signal.ts   (556 lines)
  ├── Cron: :13/:28/:43/:58 (weekdays) + econ event trigger
  ├── concurrency=1, throttle 10m, cancelOn econ events, priority econ>cron
  ├── STILL calls advanceBhgSetups()   ← WRONG — trigger contract requires replacement
  ├── ML baseline: deterministic scoring only (does not consume predict.py output)
  ├── AI reasoning: OpenRouter, 10s timeout, strictly explanatory
  └── Output: in-memory SignalPayload cache (15m TTL), ScoredTrade → DB

src/inngest/functions/mkt-mes-1m.ts
  ├── Cron: '* * * * 0-5' (every minute, market hours gated)
  ├── Ownership: getMes1mOwner() — can hand off to dedicated Python worker
  ├── Writes: mkt_futures_mes_1m (authoritative)
  └── Derives: 15m, 1h, 4h, 1d from stored 1m (not all every cycle — bucket-gated)

Live data freshness (cloud DB, snapshot 2026-03-11T20:12:31Z):
  mkt_futures_mes_1m   lag 1.9 min   ✓ LIVE
  mkt_futures_mes_15m  lag 26.9 min  ✓ current
  mkt_futures_mes_1h   lag 71.9 min  ✓ current
  NQ/RTY/ZN/CL/6E 1d   through 2026-03-10 close   ✓ current
  econ_calendar        future events loaded, ingestedAt 2026-03-11T15:02Z   ✓
  news_signals         max 2026-03-11T16:00Z   ✓ current
  geopolitical_risk    COMPLETED run id=623, 28 rows   ✓ fixed 2026-03-11
  trump_effect_1d      scheduled 19:30 UTC daily (not sampled in snapshot)
  mkt_options_*_1d     max 2026-02-24 (22,811 min stale)   ✗ RED
```

### Schema (prisma/schema.prisma)

All Warbird-required tables exist and are migrated to cloud DB:

| Table | Migration | Status |
|---|---|---|
| `mes_model_registry` | 20260213103000 | Exists, **never written to** |
| `bhg_setups` | 20260213103000 | Live (to be deprecated) |
| `scored_trades` | present | Live via compute-signal |
| `geopolitical_risk_1d` | 20260302145500 | Live ✓ |
| `trump_effect_1d` | 20260302145500 | Live ✓ |
| `mkt_futures_mes_1m/15m/1h/1d` | present | Live ✓ |
| `mkt_futures_1h/1d` (non-MES) | present | Live ✓ |
| All econ_*_1d tables | present | Live ✓ |

Symbol roles (cloud DB = local DB = snapshot as of 2026-03-11T21:30Z):
- `CORRELATION_SET`: MES, NQ, RTY, ZN, CL, 6E ✓
- `ANALYSIS_DEFAULT`: MES, NQ, YM, RTY, VX, US10Y, ZN, DX, GC, CL ✓
- `OPTIONS_PARENT`: 15 CME parents ✓

---

## Readiness Findings

### 1. Correctness and trading realism

**FINDING 1.1 — CRITICAL: Warbird regression is trained but not served.**
`train-warbird.py` writes 12 regression models to `models/warbird/`. `predict.py` loads `models/core_forecaster/` and runs binary classification (v2.1). The Warbird serving layer does not exist. The UI currently shows v2.1 UP/DOWN probabilities, not Warbird price/MAE/MFE regression outputs.
Evidence: `predict.py:MODEL_DIR = "models/core_forecaster"` vs `train-warbird.py:OUTPUT_ROOT = "models/warbird"`.

**FINDING 1.2 — HIGH: Dataset builder uses 6 cross-asset symbols, not all 63.**
`build-lean-dataset.ts:350` hardcodes `CROSS_ASSET_SYMBOLS = [NQ, ZN, CL, 6E, 6J, NG]`. AGENTS.md and ARCHITECTURE.md both state "EVERYTHING in the database goes into the dataset — all 63 symbols." The trained models have materially fewer features than the approved spec, reducing regime-detection signal.
Evidence: `build-lean-dataset.ts:350–357`; AGENTS.md:340–342; ARCHITECTURE.md:345.

**FINDING 1.3 — HIGH: Target definition computes returns, not price levels.**
`train-warbird.py:152–162` defines `target_price_{h}` as a forward return `(close[i+h] - close[i]) / close[i]`, not a future price level. AGENTS.md:379 says "Regression (price prediction)." ARCHITECTURE.md:379 says "`close.shift(-N)` for price." Return targets are a reasonable proxy but diverge from the stated contract (absolute price level). MAE/MFE are also returns, not absolute ticks.
Evidence: `train-warbird.py:155–162`.

**FINDING 1.4 — MEDIUM: GARCH falls back to EWMA silently.**
`train-warbird.py:251–262` catches arch library exceptions and substitutes EWMA vol without logging which method was used per horizon. Monte Carlo zone bounds are vol-sensitive; silently degraded vol degrades zone quality.
Evidence: `train-warbird.py:224–262`.

**FINDING 1.5 — LOW: Timezone dual-system has DST exposure.**
`/api/forecast` and `forecast-cache.ts` use `America/Chicago` (CT) for window boundaries. `compute-signal.ts` and `mkt-mes-1m.ts` gate on UTC market hours. During DST transitions (±1 hour) the window-to-market-hours alignment could shift by one cache slot.
Evidence: `forecast-cache.ts:getCurrentWindow()`; `mkt-mes-1m.ts:isMesMarketOpen()`.

**FINDING 1.6 — PASS: Temporal integrity in training is sound.**
Walk-forward CV uses explicit purge + embargo: minimum 75 rows gap (1h horizon), 141 rows (1d horizon). One-step lookahead guard confirmed: `future = close[i+1 : i+h+1]` not `[i : i+h]`. No random shuffle. No global normalization across full dataset. Feature `.asof()` lookups with conservative lag in dataset builder.
Evidence: `train-warbird.py:115–162`; `build-lean-dataset.ts` FRED lag logic.

---

### 2. Robustness and safety

**FINDING 2.1 — CRITICAL: `mes_model_registry` table is orphaned.**
The table exists (migration 20260213103000), has versioning fields (`modelName`, `version`, `isActive`, `artifactPath`, `features`), and was designed as the model tracking layer. Neither `train-warbird.py` nor `predict.py` reads or writes it. No code in the codebase references it for routing inference. There is no activation flag mechanism in use.
Evidence: schema line 781–799; grep of `mes_model_registry` yields only schema and migration.

**FINDING 2.2 — CRITICAL: ML prediction generation is fully manual with no automation.**
`predict.py` must be run manually on the local machine; it writes `public/ml-predictions.json`. There is no Inngest function, cron job, or scheduled trigger to refresh predictions. The 120-minute staleness threshold in `/api/ml-forecast` will fire constantly in production unless someone runs predict.py by hand.
Evidence: `src/app/api/ml-forecast/route.ts:98`; no Inngest function references predict.py.

**FINDING 2.3 — HIGH: Inngest webhook returning 400 for all POST requests.**
From `2026-03-09-runtime-data-flow-audit.md`: "/api/inngest currently returning 400 for all POST attempts." If this persists, all Inngest-scheduled ingestion jobs (FRED, news signals, econ calendar, GPR, trump effect, MES 15m derivation) are blocked. The MES 1m writer (mes-live-1m-worker) appears to be the dedicated Python worker that bypasses Inngest for the primary table.
Evidence: `docs/plans/2026-03-09-runtime-data-flow-audit.md:102`.

**FINDING 2.4 — HIGH: Options data 22,811 minutes stale; DATABENTO_API_KEY missing from .env.local.**
`mkt_options_statistics_1d` and `mkt_options_ohlcv_1d` have not been refreshed since 2026-02-24. Options Greeks (IV, delta, OI) are planned Warbird features. The blocker is a missing `DATABENTO_API_KEY` in `.env.local`. Options are not trigger-critical for the current trigger-base-replacement phase.
Evidence: `docs/plans/2026-03-11-trigger-data-hit-map.md`; gate 8.5 RED.

**FINDING 2.5 — HIGH: Trigger engine still routes through `advanceBhgSetups()`.**
`compute-signal.ts` calls `advanceBhgSetups()` as the base trigger generator. The approved trigger contract (`docs/plans/2026-03-09-trigger-core-contract.md`) requires this to be replaced with a new trigger-base engine using the 5-layer evaluation pipeline (base candidate → news gate → correlation confirmation → volume confirmation → price-action acceptance). None of the contract state types (`TriggerNewsState`, `TriggerVolumeState`, etc.) are implemented in runtime code.
Evidence: `compute-signal.ts`; `docs/plans/2026-03-09-trigger-core-contract.md`.

**FINDING 2.6 — MEDIUM: No automated dataset freshness validation before training.**
`train-warbird.py` assumes the input CSV exists and has valid `timestamp` + target columns (line 361–362) but does no preflight checks: row count, date range coverage, NaN ratios per feature, or minimum staleness threshold. If the dataset is rebuilt from a cold or partially ingested DB, training proceeds silently on degraded data.
Evidence: `train-warbird.py:355–380`.

**FINDING 2.7 — PASS: Ingestion idempotency is sound.**
All ingestion paths use `createMany({ skipDuplicates: true })` or `upsert` patterns. `IngestionRun` records are created on start and updated on success/failure. MES ingestion failures propagate errors; no silent swallows found in critical paths.
Evidence: CONVENTIONS.md patterns confirmed in ingestion scripts.

**FINDING 2.8 — PASS: In-memory cache survives normal operations but not restarts.**
`compute-signal.ts` caches `SignalPayload` in-memory with 15m TTL. Forecast window cache is in-memory per process. On Vercel cold-start or process recycle the cache is lost — the next request recomputes. This is acceptable for stateless serverless but means a restart during market hours produces a blank tile until the next compute-signal cycle.
Evidence: `forecast-cache.ts`; `compute-signal.ts` cache pattern.

---

### 3. Reproducibility

**FINDING 3.1 — HIGH: No pinned Python requirements for the AutoGluon environment.**
`requirements-finance.txt` covers scipy/statsmodels/sklearn/zipline — not AutoGluon. There is no `requirements-warbird.txt` or `requirements-autogluon.txt` with pinned versions for `autogluon`, `arch`, `pandas`, `numpy`, or `scikit-learn`. Training reproducibility depends on whatever version was installed in `.venv-autogluon` at setup time with no documented snapshot.
Evidence: `requirements-finance.txt`; `requirements-mes-live-1m-worker.txt`; no autogluon requirements file found.

**FINDING 3.2 — MEDIUM: TRAINING-COMPLETE.md documents the wrong system.**
`TRAINING-COMPLETE.md` describes the legacy `mes_hft_halsey/mes_autogluon_timeseries.py` timeseries forecasting approach (Chronos, TFT, DeepAR, AutoETS) with output to `mes_hft_halsey/models/autogluon_mes_1h/`. Warbird uses `TabularPredictor` (regression), not `TimeSeriesPredictor`. A new session following TRAINING-COMPLETE.md would run the wrong pipeline.
Evidence: `TRAINING-COMPLETE.md`; `train-warbird.py:problem_type="regression"`.

**FINDING 3.3 — MEDIUM: `build-warbird-dataset.ts` does not exist.**
ARCHITECTURE.md:355 references `build-lean-dataset.ts (or build-warbird-dataset.ts)` as the dataset entry point. Only `build-lean-dataset.ts` and `build-complete-dataset.ts` exist. There is no dataset builder script that implements the full 400–600+ column spec (all 63 symbols) described in AGENTS.md and ARCHITECTURE.md. The lean dataset (66 cols) is what Warbird currently trains on.
Evidence: `scripts/` directory listing; ARCHITECTURE.md:355; AGENTS.md:341.

**FINDING 3.4 — PASS: Per-fold metadata is stored.**
`fold_meta.json` per fold records: horizon, target type, selected features list, metrics (MAE, RMSE, R², IC, Sharpe), and purge/embargo values. `warbird_training_summary.json` aggregates OOF metrics across all folds. Seed is fixed at 42. Walk-forward splits are deterministic given the same dataset.
Evidence: `train-warbird.py:554–567`.

---

### 4. Operational viability for intraday

**FINDING 4.1 — HIGH: No retraining schedule or model drift monitoring.**
There is no Inngest function, cron job, or runbook for scheduled Warbird retraining. TRAINING-COMPLETE.md (wrong system) says "retrain weekly." No drift metric, no alert threshold, no mechanism to detect when OOF metrics on new data degrade past a threshold.
Evidence: no retraining Inngest function; no drift monitoring in codebase.

**FINDING 4.2 — MEDIUM: Inference latency is adequate but the pipeline is fragile.**
`/api/ml-forecast` reads a static JSON file (~50ms). If `public/ml-predictions.json` is absent, the route returns 503 with a hint to run predict.py manually. There is no fallback to a cached DB row, no retry, no alerting. The 120-minute stale flag is informational only — the UI still renders stale predictions without a hard block.
Evidence: `src/app/api/ml-forecast/route.ts:85–105`.

**FINDING 4.3 — MEDIUM: compute-signal Python subprocess is fragile (30s timeout).**
`compute-signal.ts` spawns `compute-volume-features.py` as a subprocess with a 30s timeout. A Python environment issue or path error produces a timeout failure that silently degrades volume state to a stub. No alert, no fallback state emission.
Evidence: `compute-signal.ts`; `docs/plans/2026-03-09-runtime-data-flow-audit.md`.

**FINDING 4.4 — PASS: MES 1m authoritative data path is live.**
mes-live-1m-worker RUNNING (started 2026-03-11T17:51Z). Lag 1.9 min as of snapshot. 15m derived at lag 26.9 min. Higher TFs bucket-gated and derived from stored 1m. Ownership model (`getMes1mOwner()`) allows clean handoff.
Evidence: `docs/plans/2026-03-11-trigger-data-hit-map.md`.

**FINDING 4.5 — PASS: Trigger concurrency controls are correct.**
`compute-signal.ts`: concurrency limit=1, throttle 1 per 10m, econ events cancel stale cron runs, econ event priority=200 vs cron priority=0. This prevents parallel compute-signal runs from colliding.
Evidence: `compute-signal.ts` function config.

---

### 5. Security

**FINDING 5.1 — MEDIUM: DATABENTO_API_KEY missing from `.env.local`.**
Options refresh is blocked. More importantly, if local scripts are run without this key, they fail or silently skip steps (ingest-options.py returns early). The key is present in `.env.production.local` but not in `.env.local` used by local Python scripts.
Evidence: gate 8.5 RED; `docs/plans/2026-03-11-research-capture-ledger.md`.

**FINDING 5.2 — PASS: Secret management pattern is correct.**
All API keys are read from environment variables (`.env.production.local`, `.env.local`). `.env*` files are gitignored. `DIRECT_URL` connection string contains credentials and is env-only. No evidence of keys in logs, artifacts, or committed files.
Evidence: `.env.example`; `src/lib/prisma.ts`; AGENTS.md connection rules.

**FINDING 5.3 — PASS: DB connection uses least-privilege direct path.**
`prisma.ts` uses `DIRECT_URL` → direct postgres (no Accelerate overhead or per-op billing by default). Accelerate is opt-in via `USE_ACCELERATE=1`. Bulk writes never route through Accelerate. Python scripts use `DIRECT_URL` via psycopg2 — never touch Accelerate.
Evidence: `src/lib/prisma.ts`; AGENTS.md connection rules.

---

## Action plan

**Constraint:** Main branch only, gatekeeper review required, 1–2 weeks.
**Priority:** Data gate first → inference bridge second → registry integration third → trigger replacement fourth.

---

### P0 — Data gate (Day 1–2)

**P0.1 — Add DATABENTO_API_KEY to `.env.local`**
- What: Provide the Databento API key to local `.env.local` so options ingest can run.
- Why: Gate 8.5 is RED; options Greeks are planned Warbird features. Unblocks all local Python script paths.
- Accept: `python scripts/ingest-options.py --dry-run=false` completes without error; `SELECT MAX(event_date) FROM mkt_options_statistics_1d` returns ≥ 2026-03-10.

**P0.2 — Confirm Inngest POST health**
- What: Verify `/api/inngest` accepts POST without 400. If 400 persists, trace to Vercel env vars (`INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`) or middleware block.
- Why: All scheduled ingestion depends on Inngest webhook receiving events from Inngest Cloud.
- Accept: `curl -X POST https://<vercel-deploy>/api/inngest` returns 200 or 204, not 400. Inngest dashboard shows functions as "connected."

---

### P1 — Inference bridge for Warbird regression (Days 2–5)

**P1.1 — Create `scripts/predict-warbird.py`**
- What: New inference script that loads `models/warbird/{horizon}/{price,mae,mfe}/fold_{k}/` (regression predictors), runs ensemble predict on last N rows of the lean dataset, computes zone upper/lower from pred_mfe/pred_mae, and writes to `public/warbird-predictions.json`.
- Why: Warbird trains but is never served. Finding 1.1.
- Minimal contract:
  ```json
  {
    "predictions": [{
      "timestamp": "ISO",
      "pred_price_1h": 5890.25,
      "pred_mae_1h": -0.0045,
      "pred_mfe_1h": 0.0072,
      "zone_low_1h": 5863.75,
      "zone_high_1h": 5932.50
    }],
    "meta": { "generated_at": "ISO", "model_dir": "models/warbird", "n_folds": 5 }
  }
  ```
- Accept: Script runs end-to-end; output file contains numeric values for all 4 horizons; stale age < 5 min after run.

**P1.2 — Add `/api/warbird-forecast` route**
- What: Mirror of `/api/ml-forecast` but reads `public/warbird-predictions.json`. Returns zone_low/zone_high/pred_price per horizon. Staleness threshold: 4 hours (Warbird is not sub-minute).
- Why: Creates clean serving endpoint without touching the legacy ML forecast path.
- Accept: `GET /api/warbird-forecast` returns 200 with zone fields; returns 503 + hint if file missing; `stale: true` when age > 240 min.

**P1.3 — Write training summary to `mes_model_registry`**
- What: At end of `train-warbird.py`, upsert one row per horizon/target into `mes_model_registry` with modelName=`warbird-{horizon}-{target}`, version from timestamp, artifactPath, OOF metrics (MAE, R², IC), features JSON, isActive=true.
- Why: `mes_model_registry` exists and was designed for this. Finding 2.1.
- Accept: After training run, `SELECT model_name, version, is_active, artifact_path FROM mes_model_registry` returns 12 rows; `artifact_path` points to existing directory.

---

### P2 — Automation and requirements pinning (Days 5–8)

**P2.1 — Pin Python requirements for Warbird training**
- What: Create `requirements-warbird.txt` with exact pinned versions: `autogluon[tabular]==X.Y.Z`, `arch==X.Y.Z`, `pandas==X.Y.Z`, `numpy==X.Y.Z`, `scikit-learn==X.Y.Z`, `scipy==X.Y.Z`.
- Why: Reproducibility. Finding 3.1.
- Command to generate: `pip freeze | grep -E "autogluon|arch|pandas|numpy|scikit|scipy" > requirements-warbird.txt`
- Accept: `pip install -r requirements-warbird.txt` in a fresh venv produces a working training run.

**P2.2 — Add Inngest function to run `predict-warbird.py`**
- What: New `src/inngest/functions/warbird-predict.ts` with cron `0 */4 * * 1-5` (every 4 hours, weekdays). Spawns `scripts/predict-warbird.py` as a subprocess. Writes result to DB (`mes_model_predictions` table or `scored_trades` extension — TBD).
- Why: Currently 100% manual. Finding 2.2. Predictions need refresh cadence tied to 4h horizon.
- Accept: Inngest dashboard shows function registered; cron fires; `public/warbird-predictions.json` timestamp advances on schedule.

**P2.3 — Log GARCH vs EWMA fallback per horizon**
- What: In `train-warbird.py:251–262`, add `print(f"[warbird][{horizon}] vol method: GARCH")` or `EWMA` depending on which branch executes. Add `vol_method` key to `warbird_training_summary.json`.
- Why: Silent fallback degrades zone quality invisibly. Finding 1.4.
- Accept: `models/reports/warbird_training_summary.json` contains `"vol_method": "GARCH"` or `"EWMA"` per horizon.

---

### P3 — Trigger base replacement (Days 8–14, parallel with P2)

**P3.1 — Create trigger-base engine module**
- What: New file `src/lib/trigger-base.ts` implementing `BaseTriggerCandidate` generation independent of `BhgSetup` table reads. Source: 1m candles from DB (same SIGNAL_1M_LOOKBACK). Expose: direction, entry, stop, tp1, tp2, swing context.
- Why: `compute-signal.ts` still calls `advanceBhgSetups()`. Finding 2.5.
- Go/no-go gate: Passes type check (`npx tsc --noEmit`); unit-testable without DB connection.
- Accept: `compute-signal.ts` can import and call `generateBaseTriggers()` without importing `bhg-engine`.

**P3.2 — Implement contract state types in runtime**
- What: Add `TriggerNewsState`, `TriggerVolumeState`, `TriggerAcceptanceState`, `TriggerCorrelationState`, `TriggerDecision` type declarations to `src/lib/types.ts`. Implement `evaluateTrigger(candidate, context): TriggerEvaluation` in `src/lib/trigger-evaluation.ts`. Wire into `compute-signal.ts` replacing the boolean volume field with the 5-state volume enum.
- Why: Volume contract is "too thin" (Finding 2.5); news/acceptance states are placeholder-grade.
- Accept: `compute-signal.ts` emits `TriggerEvaluation` objects with non-null `decision` and `vetoReasons[]`; old boolean `volumeConfirmation` field removed from scored trade payload.

**P3.3 — Remove `advanceBhgSetups()` from compute-signal hot path**
- What: After P3.1 and P3.2 are merged and verified, remove the `advanceBhgSetups()` call from `compute-signal.ts`. Keep `bhg_setups` table writes for historical outcome tracking only (fill in outcome fields from market data after the fact).
- Why: Definition of done for the trigger restart. Finding 2.5.
- Accept: `compute-signal.ts` no longer imports or calls `advanceBhgSetups()`; scored trades still write to DB; no type errors.

---

### Go/no-go gates (in order)

| Gate | Criterion | Verification command |
|---|---|---|
| **G0 — Data** | MES 1m lag ≤ 3 min; CORRELATION_SET freshness ≤ 90 min; options stale resolved | `SELECT MAX(event_time) FROM mkt_futures_mes_1m` (expect ≤ 3 min ago); hit-map doc re-snapshot |
| **G1 — Inference** | Warbird predictions served by `/api/warbird-forecast` with non-null zone_low/high for all 4 horizons | `curl /api/warbird-forecast` returns 200; `stale: false` |
| **G2 — Registry** | 12 rows in `mes_model_registry`, all `is_active=true`, artifact paths exist on disk | `SELECT COUNT(*) FROM mes_model_registry WHERE is_active = true` → 12 |
| **G3 — Automation** | Inngest warbird-predict function fires on schedule; predictions age ≤ 4h during market hours | Inngest dashboard + `/api/warbird-forecast` age check |
| **G4 — Trigger** | `compute-signal.ts` does not import `advanceBhgSetups`; emits `TriggerEvaluation` with 5-state volume and news | `grep advanceBhgSetups src/inngest/functions/compute-signal.ts` → no match; type check passes |

---

### Deferred (out of scope for 1–2 week window)

- Full 63-symbol dataset builder (Finding 1.2) — high-value but requires significant `build-lean-dataset.ts` rewrite and retraining run
- Absolute price-level targets replacing return targets (Finding 1.3) — requires new training run
- Distributed/Redis cache replacing in-memory (Finding 2.8) — Vercel serverless constraint; defer to scaling phase
- DST timezone alignment (Finding 1.5) — low-probability failure; document and revisit at DST transition date
- TRAINING-COMPLETE.md rewrite (Finding 3.2) — documentation debt; no functional impact

---

*Last updated: 2026-03-11*
*Evidence sources: scripts/train-warbird.py, scripts/predict.py, scripts/build-lean-dataset.ts, src/app/api/ml-forecast/route.ts, src/inngest/functions/compute-signal.ts, src/inngest/functions/mkt-mes-1m.ts, src/lib/forecast-cache.ts, src/components/MesIntraday/MLForecastTile.tsx, prisma/schema.prisma, docs/plans/2026-03-09-trigger-core-contract.md, docs/plans/2026-03-09-trigger-news-regime-spec.md, docs/plans/2026-03-11-warbird-trigger-restart-checklist.md, docs/plans/2026-03-11-trigger-data-hit-map.md, docs/plans/2026-03-09-runtime-data-flow-audit.md, docs/handoffs/2026-03-08-pre-phase1-trigger-governance-approval.md, AGENTS.md, ARCHITECTURE.md, CONVENTIONS.md*
