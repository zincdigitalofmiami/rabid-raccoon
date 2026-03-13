# Warbird Master Build Plan

**Goal:** Build Warbird — an ML-augmented Fibonacci trading system for MES futures that produces probability-scored entries, smart stops (MAE), runner targets (MFE), and setup grades from a 14-model AutoGluon ensemble + Monte Carlo simulation.

**Architecture:** Pine Script indicator (TradingView) provides clean Fibs + EMAs + price action. Dashboard (Rabid Raccoon Next.js app) mirrors Fib levels and adds Warbird intelligence: probabilities, suggested stops, runner targets, setup grades, MC confidence panel. Two screens, one system — eyes on TradingView, brain on dashboard.

**Tech Stack:** AutoGluon 1.5 (TabularPredictor), Python 3.12, GJR-GARCH (arch library), Next.js 14, Prisma (Postgres), Lightweight Charts v5.1.0, Databento (`GLBX.MDP3` approved pulls only), FRED API, Google News RSS, Pine Script v6.

---

## Table of Contents

1. [Datasets to Pull (Kirk's Side Quest)](#datasets-kirk)
2. [Phase 0: BHG → Warbird Rename](#phase-0)
3. [Phase 1: Pine Indicator Optimization](#phase-1)
4. [Phase 2: Fib Engine Backtest (Python)](#phase-2)
5. [Phase 3: Dataset Builder](#phase-3)
6. [Phase 4: AutoGluon Training](#phase-4)
7. [Phase 5: Inference Pipeline](#phase-5)
8. [Phase 6: Dashboard Warbird Cards](#phase-6)
9. [Phase 7: MC + Quantile Integration](#phase-7)
10. [Phase 8: Feedback Loop Activation](#phase-8)
11. [Guardrails](#guardrails)
12. [Testing Strategy](#testing)

---

<a name="datasets-kirk"></a>
## Datasets to Pull (Kirk — Do This Now)

While build work begins, pull these from Databento. All use `stype_in='continuous'` unless noted.

### Futures — OHLCV 1-Minute (Training Features)

| # | Symbol | Dataset | Databento Symbol | Schema | Lookback |
|---|--------|---------|------------------|--------|----------|
| 1 | MES | `GLBX.MDP3` | `MES.c.0` | `ohlcv-1m` | 2 years (2024-03-12 → now) |
| 2 | NQ | `GLBX.MDP3` | `NQ.c.0` | `ohlcv-1m` | 2 years |
| 3 | CL | `GLBX.MDP3` | `CL.c.0` | `ohlcv-1m` | 2 years |
| 4 | GC | `GLBX.MDP3` | `GC.c.0` | `ohlcv-1m` | 2 years |
| 5 | ZN | `GLBX.MDP3` | `ZN.c.0` | `ohlcv-1m` | 2 years |
| 6 | ZB | `GLBX.MDP3` | `ZB.c.0` | `ohlcv-1m` | 2 years |
| 7 | ZT (2Y) | `GLBX.MDP3` | `ZT.c.0` | `ohlcv-1m` | 2 years |
| 8 | ZF (5Y) | `GLBX.MDP3` | `ZF.c.0` | `ohlcv-1m` | 2 years |
| 9 | RTY | `GLBX.MDP3` | `RTY.c.0` | `ohlcv-1m` | 2 years |
| 10 | BTC | `GLBX.MDP3` | `BTC.c.0` | `ohlcv-1m` | 2 years |
| 11 | YM | `GLBX.MDP3` | `YM.c.0` | `ohlcv-1m` | 2 years |
| 12 | ~~DX~~ | ~~`IFUS.IMPACT`~~ | **REMOVED — ICE, NOT in CME plan. Use FRED `DTWEXBGS` or `6E.c.0` on GLBX** | | |
| 13 | CNH | `GLBX.MDP3` | `CNH.c.0` | `ohlcv-1m` | 2 years |

### MES L2 Book Data (Volume/Liquidity Features) — ON HOLD

Do not pull `mbp-10` or `trades` from Databento in this workspace without fresh written approval. Leave these features out of build work for now.

### ES Options (GEX/Skew/P-C Features) — APPROVED ONLY IF INTENTIONAL

| # | Symbol | Dataset | Schema | Lookback | Notes |
|---|--------|---------|--------|----------|-------|
| 14 | ES options | `GLBX.MDP3` | `definition` | 12 months | Instrument defs (strikes, expiry, type) |
| 15 | ES options | `GLBX.MDP3` | `ohlcv-1d` | 12 months | Daily options bars only. No quote or trade pulls. |

Use `stype_in='parent'`, `symbols='ES.OPT'` for options pulls.

### ~~ETF (Credit Spread Proxy)~~ — REMOVED

| # | Symbol | Dataset | Schema | Lookback |
|---|--------|---------|--------|----------|
| ~~20~~ | ~~HYG~~ | ~~`DBEQ.BASIC`~~ | **REMOVED — US Equities, NOT in CME plan ($136.93 charge in Feb). Use FRED `BAMLH0A0HYM2` (HY spread, already ingested daily).** | |

### ⚠️ DATABENTO BILLING GUARDRAIL

**Kirk's subscription: Standard CME (`GLBX.MDP3`) = $179/mo. NOTHING ELSE.**
- NEVER pull from `IFUS.IMPACT` (ICE) — charged $17.73 in Feb 2026
- NEVER pull from `DBEQ.BASIC` (US Equities) — charged $136.93 in Feb 2026
- NEVER pull from `XCBF.PITCH` (CBOE) in this workspace without Kirk's explicit approval
- If a dataset is not `GLBX.MDP3`, DO NOT PULL IT
- Even on `GLBX.MDP3`, do not pull `trades`, `mbp-10`, or `mbp-1` unless Kirk re-approves them

### Save Location

All files → `/Volumes/Satechi Hub/rabid-raccoon/datasets/databento/raw/`

Create subdirectories:
```
datasets/databento/raw/
├── futures-1m/          # Approved GLBX.MDP3 ohlcv-1m pulls only
├── es-options/          # Approved GLBX.MDP3 definition + ohlcv-1d pulls only
```

### FRED Series (Already Ingested — Verify Coverage)

These should already be in the DB via existing Inngest functions. Verify 2-year coverage:

| Series | FRED ID | Frequency |
|--------|---------|-----------|
| Fed Funds Rate | `FEDFUNDS` | Monthly |
| CPI | `CPIAUCSL` | Monthly |
| Core CPI | `CPILFESL` | Monthly |
| PPI | `PPIACO` | Monthly |
| Unemployment | `UNRATE` | Monthly |
| 2Y Yield | `DGS2` | Daily |
| 5Y Yield | `DGS5` | Daily |
| 10Y Yield | `DGS10` | Daily |
| 30Y Yield | `DGS30` | Daily |
| 10Y Breakeven | `T10YIE` | Daily |
| VIX (spot) | `VIXCLS` | Daily |
| Dollar Index | `DTWEXBGS` | Daily |
| Gold Fix | `GOLDAMGBD228NLBM` | Daily |
| Oil WTI | `DCOILWTICO` | Daily |
| HY Spread | `BAMLH0A0HYM2` | Daily |
| IG Spread | `BAMLC0A0CM` | Daily |
| Financial Conditions | `NFCI` | Weekly |
| EPU (Policy Uncertainty) | `USEPUINDXD` | Daily |

### Google News RSS Feeds (Automated Ingestion)

| Feed | URL |
|------|-----|
| Fed/FOMC | `https://news.google.com/rss/search?q=Federal+Reserve+FOMC+rate+decision+OR+%22Fed+rate%22&hl=en-US&gl=US&ceid=US:en` |
| CPI/Inflation | `https://news.google.com/rss/search?q=%22consumer+price+index%22+OR+%22CPI+report%22+OR+%22inflation+rate%22&hl=en-US&gl=US&ceid=US:en` |
| Oil/Hormuz | `https://news.google.com/rss/search?q=%22crude+oil%22+OR+OPEC+OR+%22Strait+of+Hormuz%22&hl=en-US&gl=US&ceid=US:en` |
| Geopolitical | `https://news.google.com/rss/search?q=%22Middle+East+conflict%22+OR+%22Iran+war%22+OR+%22geopolitical+risk%22&hl=en-US&gl=US&ceid=US:en` |
| Tariffs/Trade | `https://news.google.com/rss/search?q=Trump+tariff+OR+%22trade+war%22+OR+%22trade+policy%22&hl=en-US&gl=US&ceid=US:en` |

Rate limit: ~100 requests/hour. Append `+when:1h` for recency filter.

---

<a name="phase-0"></a>
## Phase 0: BHG → Warbird Rename

**Why first:** Every subsequent phase references these tables/types. Rename once, cleanly, before new code is written.

### Task 0.1: Prisma Schema Migration

**Files:**
- Modify: `prisma/schema.prisma` (lines 65-73, 661-709)
- Create: new migration via `prisma migrate dev`

**Steps:**
1. Rename enum `BhgPhase` → `WarbirdPhase` (same values: TOUCHED, HOOKED, GO_FIRED, EXPIRED, STOPPED, TP1_HIT, TP2_HIT)
2. Rename model `BhgSetup` → `WarbirdSetup`, table mapping `@@map("warbird_setups")`
3. Run: `npx prisma migrate dev --name rename-bhg-to-warbird`
4. Verify migration SQL renames table and enum correctly
5. Run: `npx prisma generate` to regenerate client
6. Commit: `feat: rename BhgSetup → WarbirdSetup in Prisma schema`

### Task 0.2: Core Engine Rename

**Files:**
- Rename: `src/lib/bhg-engine.ts` → `src/lib/warbird-engine.ts`
- Rename: `src/lib/bhg-setup-recorder.ts` → `src/lib/warbird-setup-recorder.ts`
- Modify: `src/lib/types.ts` (BhgSetup → WarbirdSetup)
- Modify: `src/lib/charts/BhgMarkersPrimitive.ts` → `WarbirdMarkersPrimitive.ts`

**Steps:**
1. `git mv` each file
2. Find-replace `BhgSetup` → `WarbirdSetup`, `BhgPhase` → `WarbirdPhase`, `bhg` → `warbird` in all moved files
3. Update all imports across the codebase (grep for `bhg-engine`, `bhg-setup-recorder`, `BhgMarkersPrimitive`)
4. Commit: `refactor: rename BHG engine files to Warbird`

### Task 0.3: Update All References

**Files (grep confirms ~35 files):**
- `src/components/LiveMesChart.tsx`
- `src/lib/trigger-candidates.ts`
- `src/lib/trigger-candidate-recorder.ts`
- `src/lib/ml-baseline.ts`
- `src/lib/outcome-tracker.ts`
- `src/app/api/setups/history/route.ts`
- `scripts/build-bhg-dataset.ts` → `scripts/build-warbird-dataset.ts`
- `scripts/bhg-engine.test.ts` → `scripts/warbird-engine.test.ts`
- `datasets/autogluon/bhg_setups.csv` → `datasets/autogluon/warbird_setups.csv`
- All docs/plans references

**Steps:**
1. Find-replace all `bhg` → `warbird`, `BHG` → `Warbird`, `Bhg` → `Warbird` across entire repo
2. Rename script files via `git mv`
3. Run TypeScript build: `npx tsc --noEmit` — fix any type errors
4. Run existing tests: `npx vitest run` — verify nothing broke
5. Commit: `refactor: complete BHG → Warbird rename across codebase`

### Task 0.4: Verify DB Migration

**Steps:**
1. Run: `npx prisma migrate status` to verify migration applied
2. Query: `SELECT count(*) FROM warbird_setups` — should match old bhg_setups count
3. Verify API: `curl localhost:3001/api/setups/history` still returns data
4. Commit: `chore: verify Warbird migration complete`

---

<a name="phase-1"></a>
## Phase 1: Pine Indicator Optimization

**Goal:** Clean Pine indicator to pure Fib + EMAs + price action. Optimize fibScore() math. Add test Fib levels.

### Task 1.1: Strip Dead Weight from Pine

**Files:**
- Modify: `indicators/rabid-raccoon.pine` (the AF Struct+IM code Kirk shared)

**Remove:**
- All `plotshape` marker calls (Accept/Reject/Break/Conflict/News markers)
- All `alertcondition` calls
- `showBg` background tint logic
- `showMarkers` toggle and associated logic
- News proxy VISUAL output (keep data computation for potential future model use)
- `rejectWick` toggle
- `oneShotEvent` toggle
- `conflictBreak` logic
- `imModel` "Binary Gates" branch (keep only Score + Hysteresis)

**Keep:**
- Entire Fib engine (fibScore, anchoring, structural break)
- All structure level computation
- All line drawing + zone fill
- Intermarket data fetching + regime scoring
- All input settings for Fib ratios, lookback, colors, widths

**Test:** Load modified indicator on MES 15m chart in TradingView. Fib levels should render identically. No markers, no background tint, no alerts.

### Task 1.2: Add Standard Fib Test Lines

**Files:**
- Modify: Pine indicator

**Add lines at 1pt width for all standard levels:**
- `-0.382`, `-0.236` (upper extensions) — red, 1pt
- `0` (ZERO / swing high) — white, 1pt
- `0.236`, `0.382` — white, 1pt
- `0.500` (pivot) — already exists at 2pt
- `0.618`, `0.786` — already exist (zone)
- `1.0` (swing low) — white, 1pt
- `1.236` (T1), `1.618` (T2) — already exist
- `2.0` (T3) — green, 1pt

**Add show/hide toggles** for each group.
**Add right-aligned labels** (small text, no box background) matching Kirk's screenshot style.

### Task 1.3: Add 200/50/21 EMAs

**Files:**
- Modify: Pine indicator

**Add:**
```pine
show200ema = input.bool(true, "Show 200 EMA", group="EMAs")
show50ema = input.bool(true, "Show 50 EMA", group="EMAs")
show21ema = input.bool(true, "Show 21 EMA", group="EMAs")
ema200 = ta.ema(close, 200)
ema50 = ta.ema(close, 50)
ema21 = ta.ema(close, 21)
plot(show200ema ? ema200 : na, "200 EMA", color=color.white, linewidth=1, style=plot.style_line)
plot(show50ema ? ema50 : na, "50 EMA", color=color.yellow, linewidth=1, style=plot.style_line)
plot(show21ema ? ema21 : na, "21 EMA", color=color.new(#00BCD4, 0), linewidth=1, style=plot.style_line)
```

**Test:** All three EMAs visible on chart. Toggle each off/on. Colors match spec.

### Task 1.4: Optimize fibScore()

**Files:**
- Modify: Pine indicator (fibScore function)

**Changes:**
1. Remove self-comparison (don't compare window N against itself)
2. Add `0.786` and `1.236` to the scoring ratios (currently only 0.382/0.5/0.618)
3. Weight matches by temporal distance: 8↔55 = +3, 8↔34 = +2, 8↔21 = +2, 8↔13 = +1, etc.
4. Test tolerance at `0.50%` (current is `0.10%` which is sub-tick on MES)

**Test:** Compare confluence scores before/after on 1 week of MES 15m data. Scores should be more discriminating (wider spread between good and bad anchors).

### Task 1.5: Add 89-Bar Window

**Files:**
- Modify: Pine indicator

**Add:**
```pine
fib89_high = ta.highest(high, 89)
fib89_low = ta.lowest(low, 89)
```

Include in confluence scoring. This gives session-scale context on 15m charts (~22 hours).

**Test:** Verify 89-bar window participates in scoring. On 15m chart, the 89-bar anchor should capture full-session structures.

### Task 1.6: Harden Re-Anchoring

**Files:**
- Modify: Pine indicator (structBreak logic)

**Add:**
- `breakBuffer` input (default 0.5% of range) — price must close BEYOND anchor + buffer to trigger break
- `minAnchorBars` input (default 3) — anchor must hold for N confirmed bars before re-anchor allowed

**Test:** During trending markets, re-anchoring should be less frequent. Verify levels stay stable during minor range extensions.

---

<a name="phase-2"></a>
## Phase 2: Fib Engine Backtest (Python Replication)

**Goal:** Replicate Kirk's exact fibScore() math in Python. Replay across 12 months of MES data. Generate labeled training dataset.

### Task 2.1: Port Fib Engine to Python

**Files:**
- Create: `scripts/fib_engine.py`

**Port from Pine:**
- `fibScore()` function (with Phase 1 optimizations)
- Multi-window scanning (8, 13, 21, 34, 55, 89)
- Confluence scoring with temporal distance weighting
- Structural break detection with buffer + min hold
- Level computation (pivot, zone, T1, T2, down magnets, all standard levels)

**Test:** Load same 1-week period of 15m MES data. Python levels must match Pine levels within 0.25 points (1 tick).

### Task 2.2: Replay and Label Setups

**Files:**
- Create: `scripts/backtest_fib_engine.py`

**For each bar in 12 months of 15m MES data:**
1. Compute all Fib levels via ported engine
2. Detect when price enters decision zone (0.618-0.786)
3. Record setup entry with all features at that moment
4. Look forward 1h and 4h:
   - Did T1 (1.236) get hit?
   - Did T2 (1.618) get hit?
   - What was MAE (max drawdown from entry)?
   - What was MFE (max runup from entry)?
   - Was SL hit before T1?
   - Time to T1 (bars)

**Output:** `datasets/autogluon/warbird_fib_setups_12m.csv` — one row per setup, 50+ feature columns + 6 label columns.

**Test:** Verify row count is reasonable (expect 500-2000 setups in 12 months). Spot-check 10 setups against TradingView chart manually.

---

<a name="phase-3"></a>
## Phase 3: Dataset Builder

**Goal:** Build the full Warbird training dataset: hourly rows with ~170 features from 1m bars, cross-asset, macro, volume, options, Fib structure, feedback.

### Task 3.1: Build Core Feature Pipeline

**Files:**
- Create: `scripts/build-warbird-dataset.ts`

**Feature groups (one function per group):**

| Group | Function | Columns | Source |
|-------|----------|---------|--------|
| MES price/technicals | `buildMesTechnicals()` | ~22 | 15m/1h bars from DB |
| MES 1m microstructure | `buildMesMicrostructure()` | ~20 | mkt_futures_mes_1m rollup |
| Cross-asset | `buildCrossAsset()` | ~90 | 15 symbols × 6 features |
| EMAs | `buildEmas()` | ~8 | 200/50/21 distances + stack |
| FRED macro | `buildFredMacro()` | ~48 | Existing FRED tables |
| Yield curve | `buildYieldCurve()` | ~7 | 2s10s, 5s10s, real yield |
| Volatility regime | `buildVolRegime()` | ~10 | VIX, VX term structure, GARCH |
| Geopolitical | `buildGeopolitical()` | ~10 | GPR, EPU, Trump tables |
| News/calendar | `buildNewsCalendar()` | ~14 | econ_events + timing features |
| Fib structure | `buildFibStructure()` | ~12 | Python fib engine output |
| Feedback loop | `buildFeedback()` | ~12 | warbird_setups outcomes |
| Options | `buildOptionsFeatures()` | ~12 | ES options (GEX, skew, P/C) |
| Volume/liquidity | `buildVolumeFeatures()` | 0 for now | Deferred until Kirk explicitly re-approves L2/trades pulls |
| Temporal | `buildTemporal()` | ~8 | Hour, day, session |
| Targets | `buildTargets()` | ~6 | price/MAE/MFE × 1h/4h |
| Sample weight | `buildSampleWeight()` | 1 | Exponential decay |

**Output:** `datasets/autogluon/mes_warbird_2y.csv`

**Test:**
- Row count: ~10,400 (2 years of hourly rows)
- Column count: ~257 features + 6 targets + 1 sample_weight
- No NaN in target columns
- Sample weight ranges from 0.3 (oldest) to 1.0 (newest)

### Task 3.2: Volume Feature Ingestion — DEFERRED

**Files:**
- Create: `scripts/ingest-mes-l2-features.py`

Do not implement this task until Kirk explicitly re-approves Databento `trades` and `mbp-10` usage for the workspace.

### Task 3.3: Options Feature Computation

**Files:**
- Create: `scripts/compute-options-features.py`

**From approved ES options data, compute daily only if the required inputs already exist in the workspace:**
- Put/Call ratio (volume-weighted)
- 25-delta put skew (IV_put_25d - IV_call_25d)
- GEX (gamma exposure): sum of dealer gamma × OI × 100 × spot²
- Max Pain (strike where total option value is minimized)
- 0DTE volume ratio
- Net delta-adjusted OI

If the required fields are not already present in approved local data, defer the unsupported feature instead of launching new Databento pulls.

**Test:** Validate 5 random days against the locally stored source rows used to derive each feature.

---

<a name="phase-4"></a>
## Phase 4: AutoGluon Training

### Task 4.1: Smoke Test (30 minutes)

**Files:**
- Create: `scripts/train-warbird.py`

**Configuration (smoke):**
```python
presets = 'best_quality_v150'  # Test new preset
num_bag_folds = 5
num_stack_levels = 2
dynamic_stacking = False
time_limit = 1800  # 30 min total
eval_metric = 'mean_absolute_error'  # For price target
sample_weight = 'sample_weight'
```

**Run on 1 target (price, 1h) only.** Purpose: verify no M4 Pro freeze, validate dataset loads, check memory usage.

**Test:**
- Model trains without hanging
- Peak RAM < 8GB
- Leaderboard has > 5 models
- No NaN in predictions
- Compare `best_quality_v150` vs `best_quality` leaderboard

### Task 4.2: Full Training Run

**Configuration (production):**
```python
HORIZONS = {'1h': 1, '4h': 4}
TARGETS = ['price', 'mae', 'mfe']
QUANTILES = [0.10, 0.25, 0.75, 0.90]  # For price only

# Per regression model:
presets = 'best_quality_v150'  # or best_quality if v150 fails smoke
num_bag_folds = 5
num_stack_levels = 2
dynamic_stacking = False
excluded_model_types = []  # Let AutoGluon decide; exclude foundation models if M4 freeze
eval_metric_price = 'mean_absolute_error'
eval_metric_risk = 'root_mean_squared_error'
time_limit_price = 14400  # 4h per fold
time_limit_risk = 7200    # 2h per fold
sample_weight = 'sample_weight'
ag_args_fit = {
    'num_early_stopping_rounds': 50,
    'ag.max_memory_usage_ratio': 0.8,
}
fold_fitting_strategy = 'sequential_local'
num_cpus = 11

# Walk-forward CV with purge/embargo (ported from train-final.py)
purge_window = 24  # 24 hours
embargo_window = 4  # 4 hours
```

**Model inventory:**
| # | Horizon | Target | Eval Metric | Time Limit |
|---|---------|--------|-------------|------------|
| 1 | 1h | price | MAE | 14400s |
| 2 | 1h | mae | RMSE | 7200s |
| 3 | 1h | mfe | RMSE | 7200s |
| 4 | 4h | price | MAE | 14400s |
| 5 | 4h | mae | RMSE | 7200s |
| 6 | 4h | mfe | RMSE | 7200s |
| 7 | 1h | price_q10 | pinball(0.10) | 3600s |
| 8 | 1h | price_q25 | pinball(0.25) | 3600s |
| 9 | 1h | price_q75 | pinball(0.75) | 3600s |
| 10 | 1h | price_q90 | pinball(0.90) | 3600s |
| 11 | 4h | price_q10 | pinball(0.10) | 3600s |
| 12 | 4h | price_q25 | pinball(0.25) | 3600s |
| 13 | 4h | price_q75 | pinball(0.75) | 3600s |
| 14 | 4h | price_q90 | pinball(0.90) | 3600s |

**Output:** `models/warbird/{horizon}/{target}/` — AutoGluon model artifacts per fold.

**Pre-flight checklist:**
- [ ] Close Ollama
- [ ] Verify dataset has no NaN in targets
- [ ] Verify sample_weight column exists
- [ ] Run `lsof -iTCP -sTCP:LISTEN -P -n` — no port conflicts
- [ ] Verify libomp version (brew, compatible with LightGBM on M4)

**Expected time:**
- Optimistic (v150 works): ~4-5 days
- Realistic (best_quality): ~8-10 days
- Run unattended 24/7 on M4 Pro

**Test:**
- All 14 models produce valid leaderboards
- OOF predictions have reasonable R² (> 0.05 for price, > 0.10 for MAE/MFE)
- Feature importance reports generated
- No model type dominates 100% (if so, stacking may be overfitting)

---

<a name="phase-5"></a>
## Phase 5: Inference Pipeline

### Task 5.1: Prediction Service

**Files:**
- Create: `scripts/predict-warbird.py`
- Create: `src/app/api/warbird/predict/route.ts`

**Pipeline (runs every hour):**
1. Collect last 60 bars of 1m data from `mkt_futures_mes_1m`
2. Compute all features (same functions as dataset builder)
3. Load 14 AutoGluon predictors
4. Call `predictor.predict()` → point predictions + quantiles
5. Return JSON: `{ price_1h, mae_1h, mfe_1h, price_4h, mae_4h, mfe_4h, q10_1h, q25_1h, q75_1h, q90_1h, q10_4h, q25_4h, q75_4h, q90_4h }`

**Latency target:** < 3 seconds total (feature computation + inference).

### Task 5.2: GJR-GARCH + Monte Carlo

**Files:**
- Create: `scripts/warbird_garch_mc.py`

**At inference time:**
1. Fit GJR-GARCH(1,1) on last 500 1m MES returns
2. Extract conditional volatility σ_t
3. Simulate 10,000 price paths for 1h and 4h horizons
4. For each path, check if T1/T2 levels are reached
5. Return: `{ p_t1_1h: 0.73, p_t2_1h: 0.41, p_t1_4h: 0.85, p_t2_4h: 0.62, median_path, p10_path, p90_path }`

**Test:** MC probabilities should be consistent with historical T1/T2 hit rates from the Fib backtest (Phase 2).

### Task 5.3: Inngest Scheduled Inference

**Files:**
- Create: `src/inngest/functions/warbird-predict.ts`

**Cron:** `:03` past every hour (3 minutes after hour candle closes)
**Action:** Call predict-warbird.py → store results in new `warbird_predictions` table → trigger SSE update to dashboard

---

<a name="phase-6"></a>
## Phase 6: Dashboard Warbird Cards

### Task 6.1: Warbird Prediction Card

**Files:**
- Create: `src/components/MesIntraday/Widgets/WarbirdPredictionCard.tsx`

**Replaces/augments:** Current ForecastMomentumWidget

**Content:**
```
┌─────────────────────────────────┐
│  WARBIRD · 1h                   │
│                                 │
│  Direction: SHORT · Grade A     │
│                                 │
│  T1: 6,700  ·  73%             │
│  T2: 6,660  ·  41%             │
│  Runner: 6,638                  │
│  Sugg Stop: 6,742              │
│                                 │
│  80% conf: 6,695 – 6,710       │
│  Typical pullback: 4-6 pts     │
└─────────────────────────────────┘
```

**Colors:** Match CSS variables exactly (`--zf-cyan`, `--zf-green`, `--zf-gold`, indicator hex colors for lines).

### Task 6.2: Warbird MC Panel

**Files:**
- Create: `src/components/MesIntraday/Widgets/WarbirdMCPanel.tsx`

**Small, fixed-position panel. Content:**
```
MC 10K · GARCH · 1h
T1 73% · T2 41%
Median: 6,705
```

**Style:** `bg-[rgba(30,30,30,0.85)]`, border `--zf-border`, monospace numbers, no shadow.

### Task 6.3: Update Chart Primitives

**Files:**
- Modify: `src/lib/charts/ForecastTargetsPrimitive.ts`

**Add Warbird-specific target rendering:**
- MFE Runner line: 4pt dotted, `#00BCD4` (cyan from indicator)
- T1/T2 lines: 2pt solid, `#00BCD4` (T1) / `#2196F3` (T2)
- Entry zone: 2pt solid, `#FF9800` (orange), fill at 88% opacity
- SL line: 1pt solid, red
- Clean right-aligned labels with probability %

**GUARDRAIL:** Do NOT change chart height (80vh), padding (RIGHT_PADDING_BARS=16), bar spacing (DEFAULT_BAR_SPACING=10), or candle colors. Chart is INVIOLABLE.

---

<a name="phase-7"></a>
## Phase 7: MC + Quantile Integration

### Task 7.1: Wire MC to Dashboard

**Files:**
- Modify: `src/app/api/warbird/predict/route.ts`
- Modify: `WarbirdPredictionCard.tsx`
- Modify: `WarbirdMCPanel.tsx`

**Connect inference API → cards.** SSE or polling (every 60s) to keep cards live.

### Task 7.2: Fib Level Overlay on Dashboard Chart

**Files:**
- Modify: `LiveMesChart.tsx`
- Modify: `WarbirdMarkersPrimitive.ts` (renamed from BhgMarkersPrimitive)

**Render Warbird Fib levels on the dashboard chart** — same levels as Pine indicator, computed by the Python Fib engine at inference time. Dashboard chart shows: Fib zone, pivot, T1, T2, SL, MFE runner.

---

<a name="phase-8"></a>
## Phase 8: Feedback Loop Activation

### Task 8.1: Outcome Tracking

**Files:**
- Modify: `src/lib/outcome-tracker.ts` (already exists, uses Warbird names after Phase 0)

**Every setup that fires gets tracked:**
- Did T1 hit? When?
- Did T2 hit? When?
- What was actual MAE?
- What was actual MFE?
- Did it run past T2? (Runner detection accuracy)

### Task 8.2: Feedback Features in Next Training Cycle

**Files:**
- Modify: `scripts/build-warbird-dataset.ts` (buildFeedback function)

**After 3+ months of live predictions, retrain with feedback features:**
- `t1_hit_rate_7d`, `t1_hit_rate_30d`
- `avg_mae_actual_7d`, `avg_mfe_actual_7d`
- `miss_streak`, `grade_accuracy_30d`
- `time_of_day_hit_rate`

**This is when the model starts learning from its own mistakes.**

---

<a name="guardrails"></a>
## Guardrails

### DO NOT

1. **DO NOT** touch chart height (80vh), padding, bar spacing, candle colors, or scroll behavior
2. **DO NOT** add labels, markers, or annotations to candle bars on the dashboard chart
3. **DO NOT** run Ollama during training — M4 Pro reserved for AutoGluon
4. **DO NOT** kill ports 3000/3001/8288 without asking Kirk
5. **DO NOT** use `git push --force`, `git reset --hard`, or any destructive git commands
6. **DO NOT** modify `.env.production.local` without confirming
7. **DO NOT** run `prisma migrate reset` on production DB
8. **DO NOT** use cones, bands, funnels, or shaded prediction ranges on charts
9. **DO NOT** add emoji or visual noise to the Pine indicator
10. **DO NOT** change the project name from Rabid Raccoon or model name from Warbird

### ALWAYS

1. **ALWAYS** run `lsof -iTCP -sTCP:LISTEN -P -n` before starting any server
2. **ALWAYS** use exact hex colors from the indicator code and CSS variables
3. **ALWAYS** test Pine changes on TradingView before committing
4. **ALWAYS** use point-in-time features (strictly `< current_row_timestamp`)
5. **ALWAYS** 5 folds max (AGENTS.md hard rule)
6. **ALWAYS** store decisions/corrections to memory immediately
7. **ALWAYS** update AGENTS.md when hard rules change

---

<a name="testing"></a>
## Testing Strategy

### Pine Indicator
- **Visual test:** Load on MES 15m/1h/4h charts. Levels match expectations.
- **Regression test:** Compare Fib levels before/after optimization on same data window.
- **Performance test:** Indicator loads without TradingView timeout (< 500ms).

### Fib Engine (Python)
- **Parity test:** Python levels match Pine levels within 1 tick (0.25 points) on 1 week of data.
- **Setup count test:** 500-2000 setups in 12 months is reasonable.
- **Label integrity test:** No look-ahead bias in target labels.

### Dataset
- **Shape test:** ~10,400 rows, ~257 columns, no NaN in targets.
- **Temporal test:** Timestamps are strictly ascending, no duplicates.
- **Feature range test:** No infinite values, no columns that are 100% null.

### AutoGluon Training
- **Smoke test:** 30-min run completes without freezing on M4 Pro.
- **Leaderboard test:** > 5 models per target, no single model > 90% weight.
- **OOF test:** R² > 0.05 for price, > 0.10 for MAE/MFE. If below, features need work.
- **Calibration test:** Predicted quantiles match empirical coverage (80% CI should contain ~80% of actuals).

### Inference
- **Latency test:** Full pipeline < 3 seconds.
- **Consistency test:** Same input produces same output (deterministic inference).
- **Boundary test:** Predictions within plausible MES range (no prediction of 0 or 100,000).

### Dashboard
- **Layout test:** Chart remains 80vh, no padding/spacing changes.
- **Color test:** All Warbird elements match indicator hex colors exactly.
- **Live test:** Cards update when new predictions arrive via SSE.
- **Empty state test:** Cards show "No active setup" gracefully when no signal.

---

## Execution Order

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5 ──→ Phase 6 ──→ Phase 7 ──→ Phase 8
 Rename      Pine        Backtest    Dataset     Training    Inference   Dashboard   MC Wire     Feedback
 (1 day)     (2 days)    (2 days)    (3 days)    (5-10 days) (2 days)    (3 days)    (1 day)     (ongoing)
                                        ↑
                                    Kirk pulls
                                    Databento
                                    datasets
                                    (parallel)
```

**Total estimated time:** 3-4 weeks (training runs unattended 24/7 during Phase 4).

**Kirk's parallel task:** Pull Databento datasets (items 1-20) during Phases 0-2. Data must be ready before Phase 3 starts.
