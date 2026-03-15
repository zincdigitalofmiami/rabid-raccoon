# Warbird Engine — Canonical Teardown & Reconciliation Spec v2
## The Engine Behind The Rabid Raccoon

**Date:** March 14, 2026 (v2 - final)
**Prepared for:** Kirk - Rabid Raccoon Project
**Status:** FINAL - canonical target-state spec. Clearly marks current repo reality vs target state throughout.
**Builds on:** Execution-Prep Package, Adjudication Decision, Feature Engineering Spec, ML Research Report, Trade Feedback Spec, Agent Review Findings

---

## 0. DOCUMENT CONVENTIONS — READ THIS FIRST

This spec defines **canonical target state** — the architecture Warbird is being built toward. It is NOT a description of current repo state. Where current repo reality differs from the target, the difference is explicitly called out.

Throughout this document:
- **[TARGET]** = what the system will look like after reconciliation
- **[CURRENT]** = what the repo actually contains today
- **[MISMATCH]** = an explicit gap between target and current that must be resolved during teardown
- **[RESOLVED]** = a previously open item that has been adjudicated and locked
- **[DEFERRED]** = valuable but explicitly not in Warbird v1 scope

Agents executing against this spec: if you find something marked [TARGET] that you believe conflicts with current repo reality, flag it — don't silently assume the spec is wrong or silently assume the repo is wrong. Kirk adjudicates mismatches.

---

## 1. NAMING CONVENTION — SETTLED

**Warbird** = the complete ML engine, model stack, and trigger system that powers the Rabid Raccoon.

**Rabid Raccoon** = the application/dashboard/platform that consumes Warbird's outputs and presents them alongside broader market data, correlation views, regime context, and trade management.

**[TARGET]** All former BHG (Break-Hook-Go) terminology is being renamed to Warbird throughout the codebase. BHG as a term now refers only to the *trading methodology concept* (measured moves on fib levels, trendline bounces, 4H structure -> 15M entries). The implementation of that methodology in code, models, datasets, and inference is Warbird.

**[CURRENT]** The rename is in progress. Approved additive Warbird scaffolding is already in place (`warbird-setup-recorder.ts`, `warbird-master-tasklist.md`). Some runtime/schema references still use BHG naming — specifically `prisma/schema.prisma` (line 725) and `src/lib/bhg-engine.ts`. The new recorder maps back to legacy BHG storage during transition (`warbird-setup-recorder.ts` line 71). These legacy references will be cleaned up as part of the reconciliation, not before.

**[MISMATCH]** The schema migration from BHG to Warbird table names is additive-only per the execution-prep rules. No destructive renames until the full transition is validated.

Warbird is the engine. Rabid Raccoon is the car. You don't confuse the engine with the dashboard gauges.

---

## 2. THE THREE STRANDS — DIAGNOSIS AND TRANSFORMATION PATH

The repo currently contains three divergent implementations that each own a piece of Warbird without any being authoritative. **These strands are not competing implementations of the same thing.** They are disconnected pieces of a pipeline that were built without a wiring diagram between them.

**The reconciliation path is NOT "pick a winner and kill the others." It is: define the contracts between them and wire them together. Each one survives, transformed.**

### Strand 1: Setup-Outcome Scorer
- **Location:** `scripts/train-fib-scorer.py`
- **What it does:** Trains direct T1/T2 hit models from setup CSV data
- **Labels:** Binary classification — did T1 hit? Did T2 hit?
- **[CURRENT]** Trains on setup geometry in isolation — does NOT consume the full market context feature set at the setup's go-time
- **[DEFERRED] Transformation -> Component 3 (Setup Outcome Scorer):** Not in Warbird v1. When activated in Phase 3, it gets enriched with full market context at go-time, adds missing labels (`runner_qualified`, `time_to_target`, `pullback_depth_from_go`, `outcome_r_multiple`), and manages small-N overfitting with a hybrid feature approach (core forecaster predictions as compressed features + setup-specific raw features). See Section 14 for phased roadmap.

### Strand 2: Trade-Intelligence / Live Scoring
- **Locations:** `src/inngest/functions/compute-signal.ts`, `src/lib/trade-features.ts`, `src/lib/correlation-filter.ts`, `src/lib/composite-score.ts`
- **What it does:** Computes volume, correlations, macro, news, volatility, regime, GPR, Trump, measured-move, and acceptance context features. Feeds composite scoring.
- **[CURRENT]** Richest feature surface in the system, but `composite-score.ts` weights are still `BACKTEST-TBD`. More critically: these features exist in the live scoring path but NOT in the training dataset builders — this is a **train-serve skew risk** (the #1 cause of ML systems that backtest well but fail live)
- **[TARGET] Transformation -> Shared Feature Provider + Inference Layer:** Close the train-serve gap by reconciling `trade-features.ts` features with dataset builders. Every feature in the live scoring path must also exist in the training dataset. Reclassify `composite-score.ts` — if it's re-weighting features the model already processes, eliminate it; if it's applying post-model rule-based adjustments (FOMC blackout suppression, etc.), keep it in the inference layer.

### Strand 3: Custom Warbird Model
- **Location:** `scripts/train-warbird.py`
- **What it does:** Custom MES-only AutoGluon trainer with pinball loss, GARCH, Monte Carlo, zone summaries
- **[CURRENT]** Regression — **currently derives and trains on RETURNS for price, MAE, and MFE** (see `train-warbird.py` lines 155-157)
- **[RESOLVED — ABLATION]** The canonical spec says the model predicts PRICE LEVELS + MAE bands (not returns). The checked-in trainer currently trains on returns. **This is a real architectural mismatch, not a wording issue.** Resolution: ablation test both representations on identical folds/features. Judge on downstream utility — T1/T2 alignment, MAE/MFE calibration, runner separation, confidence calibration — not just RMSE. **Inference output remains in price-space regardless**, because the rest of the engine speaks entry, stop, T1, T2, heat, and runners. If returns win the ablation, a conversion layer maps return-space predictions to price-space at inference time.
- **[TARGET] Transformation -> Core Forecaster + GARCH engine:** Refactor into two pieces. Core forecaster training (pure AutoGluon on the canonical dataset) and GARCH volatility engine (estimation + zone computation). The GARCH engine needs to be callable from both training (as features) and inference (for zones) contexts. Align feature input with canonical dataset definition.

### Why Wiring — Not Replacing — Is the Correct Path

The strands aren't contradictory — they're *incomplete*. Each one does something the others don't:
- Strand 1 knows how to evaluate specific setup outcomes (classification)
- Strand 2 knows how to compute rich market context (features)
- Strand 3 knows how to forecast price and risk (regression + volatility)

The reconciliation adds the missing labels, closes the train-serve gap, defines the interaction contracts, and wires them into the simplified v1 architecture. Strand 3 becomes the core forecaster. Strand 2's features feed it. Strand 1 waits for Phase 3 when setup count justifies its own model.

---

## 3. WARBIRD v1 ARCHITECTURE — SIMPLIFIED

The single most important design decision in this spec: **Warbird v1 ships with ONE ML model.** Everything else is rule-based or deferred.

The complexity budget goes into getting the features right and the one model family well-trained, not into coordinating three models. Ship the simple version. Prove it works. Then layer complexity with evidence.

**"ONE ML model" = one model family: the 1H core forecaster.**
This family contains one `TabularPredictor` per regression target:
`price_1h`, `price_4h`, `mae_1h`, `mae_4h`, `mfe_1h`, `mfe_4h`.
All predictors train on the same canonical 1H dataset and use the same AutoGluon configuration.
This is NOT the legacy 12-model multi-horizon architecture from `AGENTS.md`.

```
┌─────────────────────────────────────────────────────────────────┐
│                   WARBIRD v1 ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  LAYER 1: DAILY — The 200-Day MA Shadow (Rule-Based)  │     │
│  │                                                        │     │
│  │  How the globe is spinning. The macro trend.           │     │
│  │                                                        │     │
│  │  • One calculation: price vs 200d MA                   │     │
│  │  • Above 200d MA -> bias LONG                          │     │
│  │  • Below 200d MA -> bias SHORT                         │     │
│  │  • The line in the sand every desk on the planet       │     │
│  │    watches. Go against it, you're stacking risk.       │     │
│  │  • Counter-trend trades: allowed but penalized         │     │
│  │    (reduced size, T1 only, no runners)                 │     │
│  │  • Also provides continuous features to the model:     │     │
│  │    distance from 200d, slope of 200d, sessions on      │     │
│  │    current side                                        │     │
│  └──────────────────────┬─────────────────────────────────┘     │
│                         │ "The planet says LONG/SHORT"          │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  LAYER 2: 4H — Trend & Structure (Rule-Based)         │     │
│  │                                                        │     │
│  │  • Higher-highs/higher-lows or lower-highs/lower-lows │     │
│  │  • Trendlines, swing structure                         │     │
│  │  • Confirms or denies daily direction                  │     │
│  │  • Does NOT generate trade geometry (too wide for      │     │
│  │    20-40pt day trades)                                 │     │
│  │  • Answers: "Which way is the current swing moving?"   │     │
│  └──────────────────────┬─────────────────────────────────┘     │
│                         │ "Trend confirms BULL/BEAR/NEUTRAL"    │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  LAYER 3: 1H — Core Forecaster + Fib Geometry         │     │
│  │  (ONE ML model family + Rule-Based Geometry)          │     │
│  │                                                        │     │
│  │  THIS IS WHERE THE FIBS LIVE.                          │     │
│  │  THIS IS WHERE TRADES ARE IDENTIFIED.                  │     │
│  │                                                        │     │
│  │  ML Model Family (AutoGluon TabularPredictor):        │     │
│  │  • Predicts: price levels + MAE/MFE bands             │     │
│  │  • Consumes: ~150 features (technical, macro,         │     │
│  │    cross-asset, calendar, news, surprise z-scores,    │     │
│  │    risk context, trade feedback, daily/4H context)    │     │
│  │  • GARCH volatility as input features                 │     │
│  │  • Regime-anchored features from Jan 20, 2025         │     │
│  │  • Trained on 2 years of data (model sees both        │     │
│  │    regimes), regime features tell it which one        │     │
│  │                                                        │     │
│  │  Fib Geometry (Rule-Based):                           │     │
│  │  • Measured moves on 1H candles                       │     │
│  │  • Fib retracements and extensions                    │     │
│  │  • Entry / SL / TP1 / TP2 computation                 │     │
│  │  • 20-40+ point trade targets                         │     │
│  │  • Custom fib logic + volume + correlations +         │     │
│  │    symbology + news + volatility context              │     │
│  │  • Model prediction and fib geometry on the SAME      │     │
│  │    canvas — direct comparison possible                │     │
│  └──────────────────────┬─────────────────────────────────┘     │
│                         │ "Trade HERE, targets THERE,           │
│                         │  expect THIS MUCH heat"               │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  LAYER 4: 15M — Entry Trigger Confirmation            │     │
│  │  (Rule-Based in v1)                                   │     │
│  │                                                        │     │
│  │  • Candle close confirmation at fib level             │     │
│  │  • Volume expansion on trigger bar                    │     │
│  │  • Stoch RSI check                                    │     │
│  │  • Correlation confirmation at trigger moment         │     │
│  │  • Uses 1H model output as context (not a separate    │     │
│  │    ML model in v1)                                    │     │
│  └──────────────────────┬─────────────────────────────────┘     │
│                         │ "GO / NO-GO"                          │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  CONVICTION MATRIX (Rule-Based)                       │     │
│  │                                                        │     │
│  │  Daily + 4H + 1H + 15M all agree                      │     │
│  │    -> MAXIMUM conviction                              │     │
│  │      Full position, runners OK                        │     │
│  │                                                        │     │
│  │  Daily + 4H + 1H agree, 15M weak                      │     │
│  │    -> WAIT for 15M confirmation or reduce size        │     │
│  │                                                        │     │
│  │  Daily + 4H agree, 1H identifies opportunity          │     │
│  │    -> READY — watch for 15M entry                     │     │
│  │                                                        │     │
│  │  Daily + 4H agree, 1H/15M not yet aligned             │     │
│  │    -> PATIENT — bias is set, wait for lower TFs       │     │
│  │                                                        │     │
│  │  4H + 1H + 15M agree, Daily neutral (near 200d MA)    │     │
│  │    -> MODERATE conviction                             │     │
│  │      Reduced size, T1 target, quick management        │     │
│  │                                                        │     │
│  │  4H + 1H + 15M agree, Daily against (counter-trend)   │     │
│  │    -> LOW conviction — COUNTER-TREND                  │     │
│  │      Reduced size, T1 only, NO runners                │     │
│  │      Must have clearance — enough room for trade      │     │
│  │                                                        │     │
│  │  Daily against + any other disagreement               │     │
│  │    -> NO TRADE — swimming upstream with no paddle     │     │
│  └──────────────────────┬─────────────────────────────────┘     │
│                         │                                       │
│                         ▼                                       │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  INFERENCE OUTPUT (WarbirdSignal)                     │     │
│  │  • Versioned schema (v1.0)                            │     │
│  │  • Consumers: API -> Dashboard -> (future) Pine Script│     │
│  │  • GARCH zones for risk visualization                 │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Critical Architecture Rules

**Rule 1: ONE ML model family in v1.**
The 1H core forecaster is the only ML model family in production for Warbird v1. The 15M ML model (Phase 2) and setup outcome scorer (Phase 3) are deferred until the foundation is proven. This reduces maintenance surface, debugging complexity, and coordination risk by 3x.

**Rule 2: Warbird risk signals are FEATURES, not FILTERS.**
GPR, TrumpEffect, GARCH outputs enter the model as feature columns. AutoGluon learns the interaction weights. No hardcoded filter hierarchy unless A/B evidence proves filter superiority.

**Rule 3: Daily 200d MA is the directional shadow.**
Asset above the 200d MA -> look for longs. Below -> look for shorts. Counter-trend trades are allowed but explicitly penalized: reduced size, T1 only, no runners. The sheer power of trend is real. Go against it, you're stacking risk.

**Rule 4: 4H confirms trend and structure. It does NOT generate trade geometry.**
4H fibs would give levels 80-150 points apart — that's a swing trade, not a day trade. 4H answers "which way is the swing moving?" The 1H answers "where do I trade within that swing?"

**Rule 5: 1H is where the fibs live and trades are identified.**
Measured moves, fib retracements, fib extensions — all on 1H candles. This produces 20-40+ point trade targets with multiple opportunities per session. The core forecaster operates on the same timeframe as the fib geometry, so model predictions and setup levels sit on the same canvas.

**Rule 6: Volume is LOAD-BEARING for T2/runner decisions.**
Volume is not a generic feature. It's the primary discriminator between T1-and-done setups and runners. Volume expansion after T1 -> hold for T2. Volume exhaustion at T1 -> take profit. Micro-pullbacks with volume drop followed by volume spike -> continuation. The core forecaster must have rich volume features, and the conviction matrix considers volume for runner eligibility.

---

## 4. THE DAILY LAYER — 200-DAY MA SHADOW

The 200-day MA is the line in the sand. Every institutional desk on the planet watches it. It's the gravity that pulls price action back when moves get extended, and the floor/ceiling that confirms when trends are real.

### Implementation

Computationally trivial. Architecturally load-bearing.

```
MES above 200d MA -> Warbird bias: LONG
                     With-trend setups = full conviction available
                     Counter-trend shorts = explicit risk flag,
                       reduced size, T1 only, no runners

MES below 200d MA -> Warbird bias: SHORT
                     With-trend setups = full conviction available
                     Counter-trend longs = explicit risk flag,
                       reduced size, T1 only, no runners
```

Counter-trend trades can work. Kirk has proven that. But they stack risk, and in this regime the trend has been relentless. The system makes counter-trend possible but explicitly penalized.

### Daily Features for the Core Forecaster

The daily context also enters the 1H model as continuous features — not just the binary above/below signal:

| Feature | Type | Purpose |
|---------|------|---------|
| `price_vs_200d_ma` | Binary (1 = above, 0 = below) | The line in the sand |
| `distance_from_200d_ma_pct` | Continuous | How extended? 0.5% vs 8% are different worlds |
| `slope_200d_ma` | Continuous | Trend accelerating, steady, or flattening? |
| `sessions_above_below_200d` | Continuous | Trend duration — how long on this side? |
| `daily_ret` | Continuous | Today's move in context |
| `daily_range_vs_avg` | Continuous | Is today's range normal or expanded? |

The binary tells the model "which side of the line." The continuous features tell it "how far from the line, how steep the slope, how long we've been here." A trade 0.5% above the 200d MA is very different from 8% above it — the model should know that.

---

## 5. 1H LAYER — WHERE FIBS LIVE AND TRADES ARE IDENTIFIED

The 1H timeframe does double duty in Warbird v1:

### Fib Geometry (Rule-Based)

This is the trigger detection system. It identifies trade candidates using:
- **Custom fib logic** — measured moves, retracements, extensions on 1H candles
- **Volume** — expansion confirms breakout is real, not a liquidity-thin poke
- **Correlations** — cross-asset alignment (NQ, DXY, VIX, yields) at trigger moment
- **Symbology** — index alignment score, relative strength
- **News/volatility context** — event proximity, regime state
- **Output:** Candidate setup geometry (fibLevel, fibRatio, entry, SL, TP1, TP2, direction)

**[MISMATCH]** The trigger contract in the original spec (v1) defined triggers narrowly as "measured moves / fibs / 4H structure / 15M entries" — the older rule-only structure. The REAL trigger contract is broader: custom fibs PLUS volume, correlations, symbology, news, and volatility are all part of the trigger evaluation itself, not just downstream model context. This v2 spec corrects that.

### Core Forecaster (ML Model)

One AutoGluon model family operating on 1H bars:
- **Predicts:** Price levels + MAE/MFE bands (see Section 9 for label details)
- **Consumes:** ~150 features including daily/4H context, regime-anchored features, all macro/cross-asset/news/risk signals
- **Training data:** Full 2 years of history (model sees both regimes)
- **Regime features:** Computed from January 20, 2025 (model knows which regime it's in)

Because the model and the fib geometry operate on the same 1H canvas, their outputs are directly comparable. When the model says "price target 5,460" and the 1H fib extension says TP1 at 5,458, that's confirmation. When they diverge significantly, that's information too.

---

## 6. VOLUME'S ROLE — FIRST-CLASS, NOT JUST-ANOTHER-FEATURE

Volume is not a generic feature that gets tossed into the model alongside 149 others. It plays a specific, load-bearing role at multiple points in the architecture:

### Volume in Trigger Detection (1H Fib Geometry)
- **Volume expansion on the trigger candle** confirms the measured move breakout is real, not a liquidity-thin poke
- **Volume relative to session average** distinguishes institutional flow from noise
- This is rule-based, not learned — it's part of the setup validation before any model scoring happens

### Volume in Core Forecaster (1H Model)
- `vol_ratio` (current volume / rolling average volume) already exists in the dataset
- Volume profile features at 1H resolution inform directional bias
- Abnormal volume is a regime indicator — high volume trending periods are structurally different from low volume chop

### Volume for Runner Decisions — THIS IS WHERE IT'S CRITICAL
- **T1 hit probability:** Setups with above-average trigger volume have higher T1 hit rates (institutional conviction behind the move)
- **Runner qualification (T2|T1):** After T1 is hit, the key question is "does this move have legs?" Volume is the answer:
  - Volume EXPANSION after T1 -> runner probability increases -> hold for T2
  - Volume EXHAUSTION at T1 -> take profit, this is the terminal move
  - Micro-pullback with volume DROP followed by volume SPIKE -> continuation pattern -> T2 likely
- **Time-to-target:** High volume setups tend to resolve faster (less back-and-fill, more directional conviction)

### Volume Features in the Canonical Dataset

| Feature | Resolution | Purpose |
|---------|-----------|---------|
| `vol_ratio` | 1H | Already exists — volume relative to rolling average |
| `vol_expansion_trigger` | At go-time | Volume on trigger candle vs session average |
| `vol_relative_to_session` | 1H | Where in the session's volume distribution is current bar? |
| `vol_profile_at_tp1` | At T1 hit time | Volume character when T1 was reached (runner decision input) |
| `vol_trend_post_trigger` | Post-entry bars | Is volume expanding or exhausting after entry? |
| `micropullback_vol_pattern` | 15M | Volume drop -> spike pattern detection for continuation |

**Post-entry trade-management note:** `micropullback_vol_pattern`, `vol_profile_at_tp1`, and `vol_trend_post_trigger` are NOT inputs to the v1 1H core forecaster. They are only knowable after entry / T1 and therefore belong to the post-entry trade-management layer. In Warbird v1 this layer is rule-based; in Warbird v2 these features can feed a dedicated runner / trade-management model.

---

## 7. REGIME ANCHOR — JANUARY 20, 2025

**[RESOLVED]** The operating regime is anchored to the start of the current Trump presidency. This is not arbitrary — tariff escalation, fiscal policy shifts, geopolitical realignment, record market moves all live within this window. Using pre-regime data to normalize policy-driven features actively misleads the model.

### The Split

| Concern | Resolution |
|---------|-----------|
| **Training data scope** | Full 2 years of history — model sees both regimes |
| **Feature lookback windows (policy-sensitive)** | Anchored to January 20, 2025 |
| **Feature lookback windows (structural/cyclical)** | Keep standard rolling (20d, 5d, etc.) |
| **GARCH estimation window** | Anchored to January 20, 2025, expanding |
| **Regime indicator features** | Explicit regime flag + days-into-regime as features |

The model learns what THIS regime looks like because the features tell it. The model learns what a DIFFERENT regime looks like because the training rows show it. Both pieces of knowledge survive.

### Regime Constant

```typescript
// Single source of truth for regime anchor
// Updated by Kirk when regime boundary is identified
export const REGIME_START = new Date('2025-01-20T00:00:00Z')
export const REGIME_LABEL = 'trump_2'
```

Every regime-anchored feature computation references this constant. When the regime changes, update one value and rebuild the dataset.

### Dual-Lookback Implementation

For policy-sensitive features, carry BOTH the regime-anchored computation and the standard rolling window:

```
Dollar momentum:
  dollar_momentum_5d          -> standard 5-day rolling (captures micro moves)
  dollar_momentum_regime      -> change since Jan 20, 2025 (captures regime trend)

VIX context:
  vix_percentile_20d          -> relative to last 20 days (recent context)
  vix_percentile_regime       -> relative to entire regime period (regime context)
  vix_raw                     -> absolute level (unprecedented capture)

Surprise z-scores:
  nfp_surprise_z_3yr          -> 3-year rolling window (cross-regime comparison)
  nfp_surprise_z_regime       -> regime-window only (THIS environment's baseline)
  nfp_surprise_raw            -> raw value (uncompressed)

Cross-asset correlations:
  es_zn_corr_20d              -> 20-day rolling (recent relationship)
  es_zn_corr_regime           -> since Jan 20, 2025 (regime relationship)
```

---

## 8. UNPRECEDENTED MARKET DESIGN PRINCIPLES

We are seeing historical, record-level moves. The system must capture these without limitations. Every design decision must be tested against: "does this compress or clip the signal when the market does something it's never done before?"

### The Core Principle

**For every normalized/transformed feature, also carry the raw continuous value as a companion column.** Give the model both the normalized view and the raw view. Let AutoGluon learn which matters.

| Current Design | What to Add | Why |
|---------------|------------|-----|
| Surprise z-score (normalized) | Raw surprise value (absolute) | Z-score compresses in regime shifts |
| VIX percentile (relative to recent) | Raw VIX level (absolute) | Percentile loses resolution at extremes |
| Binary spike/stress flags | Continuous underlying value | Hardcoded thresholds don't adapt |
| GARCH forecast only | GARCH + realized vol + ratio | Captures estimation lag in new regimes |
| Single lookback velocity | Dual lookback (short + regime) | Market tempo varies by regime |

### Why This Works with AutoGluon's Tree Models

AutoGluon's tree-based models (GBM, CAT, XGB) naturally handle unprecedented values well. They split on absolute values, so raw features at record levels don't break them — the model just learns a new split point. This is one of the strongest arguments for the tree-based ensemble approach over neural networks for this use case.

**The NN_TORCH exception:** Neural networks normalize inputs, and record-level values get mapped to regions the network has never trained on. This doesn't mean drop NN_TORCH from the ensemble — it provides diversity. But the trees are the workhorses in a record-breaking market. AutoGluon's weighted ensembling will naturally downweight NN_TORCH where it's uncertain.

### Binary Flags -> Continuous Values

Replace hardcoded binary flags with continuous underlying values wherever possible:

- Instead of `jpySpikeFlag = 0/1` -> give `jpy_daily_change_pct` (continuous)
- Instead of `cnyStressFlag = 0/1` -> give `cny_daily_change_sigma` (continuous)
- Instead of `ovxVixDivergence = 0/1` -> give `ovx_vix_ratio` (continuous)
- Instead of `wtiShockFlag = 0/1` -> give `wti_daily_return_sigma` (continuous)

The model learns its own thresholds — and those thresholds can be different in different regimes. Binary flags should only survive where there's a genuine structural discontinuity (FOMC day is binary — it either is or isn't).

### No Hardcoded Ceilings

The conviction matrix, signal thresholds, GARCH parameters — none should have hardcoded ceilings that assume "the market can't go higher/more volatile than X." The model learns the boundaries from data. Our job is to make sure the data reaches the model unclipped.

---

## 9. LABEL TAXONOMY — COMPLETE

These are complementary model objectives serving different questions. They are NOT contradictory.

### Regression Labels (Core Forecaster — Warbird v1)

| Label | Definition | Model | Why It Matters |
|-------|-----------|-------|----------------|
| `target_price_1h` | Predicted price level 1 hour forward | 1H model | Directional target — NOT a return, an actual price |
| `target_price_4h` | Predicted price level 4 hours forward | 1H model | Structural target for measured move completion |
| `target_mae_1h` | Maximum adverse excursion within 1h window | 1H model | Stop placement — how much heat to expect |
| `target_mae_4h` | Maximum adverse excursion within 4h window | 1H model | Wider stop for structural positions |
| `target_mfe_1h` | Maximum favorable excursion within 1h window | 1H model | Profit potential — used for T1/T2 calibration |
| `target_mfe_4h` | Maximum favorable excursion within 4h window | 1H model | Runner potential estimation |

**[RESOLVED — ABLATION]** The spec says PRICE LEVELS. The checked-in `train-warbird.py` (lines 155-157) currently trains on RETURNS. Resolution: ablation test both representations on identical folds/features. Judge on downstream utility (T1/T2 alignment, MAE/MFE calibration, runner separation) not just RMSE. **Inference output remains in price-space regardless** — the rest of the system speaks entry, stop, T1, T2, heat, runners. If returns win, a conversion layer maps to price-space at inference.

**Why price levels are the inference language:** "ES at 5,450 with MAE of 12 points" gives you concrete levels for stops and targets. "ES up 0.2%" requires a conversion step and loses precision at scale. The fib geometry produces absolute levels (TP1 at 5,458), so the inference contract must speak the same language regardless of what the trainer optimizes internally.

### Classification Labels (Setup Outcome Scorer — [DEFERRED] Phase 3)

These labels still get computed and stored in the setup table. They are not consumed by a separate ML model in v1 — they're available for analysis and for Phase 3 activation.

| Label | Definition | Status |
|-------|-----------|--------|
| `tp1_hit` | Binary: did price reach T1 before SL? | Computed and stored |
| `tp2_hit` | Binary: did price reach T2 before SL? | Computed and stored |
| `runner_qualified` | Binary: after T1 hit, did price continue to T2 without retracing to entry? | Needs computation logic defined |
| `time_to_tp1_bars` | Bars from go-time to T1 hit | Computed and stored |
| `time_to_tp2_bars` | Bars from go-time to T2 hit | Computed and stored |
| `time_to_sl_bars` | Bars from go-time to SL hit | Computed and stored |
| `pullback_depth_from_go` | Max adverse move from entry before resumption | Needs computation logic defined |
| `outcome_r_multiple` | Actual R: (exit - entry) / (entry - SL) | Needs computation logic defined |

**Why `runner_qualified` is distinct from `tp2_hit`:** T2 hit means the trade reached T2 at any point. Runner qualified means T1 hit first, THEN price continued to T2 without first retracing to entry. This is the "should I hold for T2 after banking T1?" decision — and volume is the primary discriminator here.

---

## 10. DATASET INVENTORY

### Current Dataset Surfaces

| Script | Timeframe | History | Columns | Status |
|--------|-----------|---------|---------|--------|
| `build-lean-dataset.ts` | 1H | All DB data | 77 (current), ~66 lean | **SURVIVES** — canonical 1H dataset for core forecaster |
| `build-15m-dataset.ts` | 15M | `--days-back=365` | 76 | **SURVIVES** — feeds [DEFERRED] 15M model; currently builds forward return targets, needs alignment to price-level labels when activated |
| `build-bhg-dataset.ts` | Setup-level | All completed setups | Setup geometry + context | **SURVIVES** — renamed to `build-warbird-setup-dataset.ts`, feeds [DEFERRED] setup scorer |
| `build-1m-dataset.ts` | 1M | 6 months | **Not minimal** — already carries FRED, GPR, Trump, calendar, news/policy, multi-horizon targets | **EVALUATE** — richer than previously assessed; may be useful for micro-pullback volume analysis |

### Canonical Dataset for Warbird v1: 1H Core Forecaster

- **Rows:** One per 1H MES candle (currently ~11,688; grows with time)
- **Training window:** 2 full years of data
- **Labels:** `target_price_1h`, `target_price_4h`, `target_mae_1h`, `target_mae_4h`, `target_mfe_1h`, `target_mfe_4h`
- **Feature Sources:**
  - MES technicals (existing) — returns, RSI, MA, rolling std, range, body_ratio, vol_ratio, dist_hi/lo
  - Time features (existing) — hour_utc, day_of_week, session flags, month boundaries
  - Daily context features (NEW) — price_vs_200d_ma, distance_from_200d_ma_pct, slope_200d_ma, sessions_above_below_200d, daily_ret, daily_range_vs_avg
  - Raw FRED as-of (P1 done, ~90-95 cols) — 47+ series forward-filled
  - Derived FRED (P2 pending) — velocity, percentile, momentum features with array-based pattern
  - Cross-asset futures (P3 pending, highest complexity) — ES/NQ/YM/RTY/ZN/CL/GC/SOX aligned to MES timestamps
  - Calendar events (P4 pending) — FOMC day, CPI day, NFP day, hours to next high impact
  - News signals (P5 pending) — layer counts, net sentiment
  - **Surprise z-scores (HIGHEST ROI, requires macro_report_1d backfill)** — z-scored surprises with BOTH 3yr rolling window AND regime-window, PLUS raw surprise values
  - Trade feedback features (Approach A) — rolling Warbird setup win rates, streaks, R-multiples (~12-15 cols)
  - Geopolitical risk features — GPR index (level + momentum), TrumpEffect signals
  - GARCH volatility features — both raw sigma and volatility ratio
  - Regime features — REGIME_START anchor, days_into_regime, regime label
- **Dual-lookback columns** — regime-anchored + standard rolling for policy-sensitive features
- **Raw companion columns** — continuous values alongside all binary flags and normalized features
- **Expected column count after all phases:** ~150-170 columns (increased from ~150 due to dual-lookback and raw companions)
- **Builder:** `build-lean-dataset.ts`

---

## 11. FEATURE SOURCE RECONCILIATION — CANONICAL REGISTRY

Every feature must be tagged: which component consumes it, what phase builds it, what data source feeds it. No feature exists in limbo.

### Feature Engineering Spec Phases — Mapped to Components

| Phase | Features | Source | Consumer | Status |
|-------|----------|--------|----------|--------|
| P1: Raw FRED integration | 18 new raw series | FRED API | Core Forecaster | ✅ Implemented (~90-95 cols) |
| P2: Derived FRED | ~30 features (velocity, percentile, momentum) | Computed from P1 | Core Forecaster | ⏳ Pending — requires array-based pattern refactor |
| P3: Cross-asset futures | ~15 features (ratios, correlations, alignment scores) | mkt_futures_1h | Core Forecaster | ⏳ Pending — highest complexity, do last |
| P4: Calendar events | ~6 features (event day flags, proximity, counts) | econ_calendar | Core Forecaster | ⏳ Pending |
| P5: News signals | ~4 features (layer counts, net sentiment) | news_signals | Core Forecaster | ⏳ Pending |

### Surprise Z-Scores — HIGHEST ROI

| Feature | Source | Status |
|---------|--------|--------|
| `nfp_surprise_z_3yr` + `nfp_surprise_z_regime` + `nfp_surprise_raw` | macro_report_1d | ⏳ Requires backfill |
| `cpi_surprise_z_3yr` + `cpi_surprise_z_regime` + `cpi_surprise_raw` | macro_report_1d | ⏳ Requires backfill |
| `ppi_surprise_z_3yr` + `ppi_surprise_z_regime` + `ppi_surprise_raw` | macro_report_1d | ⏳ Requires backfill |
| `gdp_surprise_z_3yr` + `gdp_surprise_z_regime` + `gdp_surprise_raw` | macro_report_1d | ⏳ Requires backfill |
| `retail_surprise_z_3yr` + `retail_surprise_z_regime` + `retail_surprise_raw` | macro_report_1d | ⏳ Requires backfill |
| `claims_surprise_z_3yr` + `claims_surprise_z_regime` + `claims_surprise_raw` | macro_report_1d | ⏳ Requires backfill |
| `pce_surprise_z_3yr` + `pce_surprise_z_regime` + `pce_surprise_raw` | macro_report_1d | ⏳ Requires backfill |
| `econ_surprise_index` (composite) | Computed | ⏳ Requires backfill |
| `surprise_momentum_3mo` | Computed | ⏳ Requires backfill |

**Why three representations per surprise:** The z-score (3yr) gives cross-regime comparison. The z-score (regime) gives THIS environment's baseline. The raw value gives absolute magnitude without compression. The model sees all three and learns which matters. Per CME Group 2025 research, surprise features are THE critical signal for 1-4h prediction windows — exactly our horizon.

### Trade Feedback Features

| Feature Group | Count | Source | Status |
|--------------|-------|--------|--------|
| Rolling win rates (last 20/50 setups) | 2 | warbird_setups | ⏳ Pending |
| Average R-multiple (recent) | 1 | warbird_setups | ⏳ Pending |
| Streak tracking (consecutive W/L) | 2 | warbird_setups | ⏳ Pending |
| Setup frequency (7d/30d counts) | 2 | warbird_setups | ⏳ Pending |
| Directional bias (bull/bear win rates) | 2 | warbird_setups | ⏳ Pending |
| Fib ratio performance (deep/shallow) | 2 | warbird_setups | ⏳ Pending |
| Timing features (avg time to T1, avg MAE/MFE) | 3 | warbird_setups | ⏳ Pending |

### Geopolitical & Volatility Risk Features

| Feature | Source | Status |
|---------|--------|--------|
| GPR index (level + regime-anchored momentum) | GeopoliticalRisk table | ⏳ Pending ingestion |
| TrumpEffect signal | TrumpEffect table | ⏳ Pending ingestion |
| GARCH volatility forecast (raw sigma) | GJR-GARCH engine | ⏳ Pending |
| GARCH volatility ratio (forecast/realized) | GJR-GARCH engine | ⏳ Pending |

### Train-Serve Gap — CRITICAL RECONCILIATION

**[MISMATCH]** Features in `trade-features.ts` exist in the live scoring path but NOT in the training dataset builders. This must be reconciled. Every feature computed at inference time must also exist in the training dataset, or the model has never seen it and can't use it.

Reconciliation approach: audit every feature in `trade-features.ts` and classify into:
- **(a)** Belongs in training dataset -> add to builder
- **(b)** Post-model rule-based adjustment -> stays in inference layer only
- **(c)** Redundant with existing dataset feature -> remove from live path

---

## 12. MODEL STACK — WARBIRD v1

### ONE Model: Core Forecaster (1H)

**[CURRENT]** `train-warbird.py` exists with custom AG settings, pinball loss, GARCH, Monte Carlo.

**[TARGET]** Refactored into two pieces:
1. **Core forecaster training** — pure AutoGluon on the canonical 1H dataset
2. **GARCH engine** — separate module for volatility estimation, callable from both training (produces features) and inference (produces zones)

### Canonical AutoGluon Configuration

```python
# THE canonical AutoGluon configuration for Warbird v1 core forecaster
# Source of truth: this document. All other references derive from here.

predictor = TabularPredictor(
    label=target_col,
    eval_metric='root_mean_squared_error',
    path=output_dir,
)

predictor.fit(
    train_data=train,
    presets='best_quality',                    # v1.5 zeroshot portfolio
    num_bag_folds=5,                           # LOCKED — aligns with AGENTS.md + trainer
    num_stack_levels=1,                        # Keep at 1 (2+ rarely helps)
    dynamic_stacking='auto',                   # Detects stacked overfitting
    excluded_model_types=['KNN', 'FASTAI', 'RF'],  # Waste compute on this dataset
    ag_args_ensemble={
        'fold_fitting_strategy': 'sequential_local'  # Memory-safe for Apple Silicon
    },
)

# Models: GBM, CAT, XGB, XT, NN_TORCH — core, don't remove any
# CPU-only constraint: no TabPFNv2, no TabICL
# Sequential symbol training — no parallel training on Apple Silicon
```

### [MISMATCH] AG Config Drift: Stack Levels + Excluded Models

The spec sets `num_stack_levels=1` and excludes `KNN`, `FASTAI`, `RF`. `AGENTS.md` has been synced to this canonical configuration, but the checked-in `train-warbird.py` (lines 67-71) still says `num_stack_levels=2` and no exclusions.

**This spec is canonical.** `train-warbird.py` must be synced to match:
- `num_stack_levels=1` (2+ rarely helps, adds significant training time)
- `excluded_model_types=['KNN', 'FASTAI', 'RF']` (waste compute on this dataset)

### [MISMATCH] Model Family Implementation Drift

Warbird v1 is ONE model family (1H core forecaster with six target-specific predictors). `AGENTS.md` has been aligned to that governance. The remaining drift is implementation-side: checked-in training code and legacy supporting docs still need to fully reflect the one-family / six-predictor v1 contract.

**This spec is canonical.** The trainer implementation must reflect Warbird v1's single-model-family architecture, with broader multi-model expansion documented only as a future path (Phase 2/3).

### Fold Count — [RESOLVED]

| Source | Says | Authority |
|--------|------|-----------|
| Current baseline (memory) | 4 folds | Observed production behavior (outdated) |
| `AGENTS.md` (line 385) | Max 5 folds | Repo hard rule |
| `train-warbird.py` (line 67, 82) | 5 folds | Checked-in trainer default |
| `warbird-implementation-plan.md` (line 233) | 8 folds | Approved plan (upgrade path) |
| ML Research Report Option A | 8 folds (recommended upgrade) | Research |

**[RESOLVED] Locked at 5 folds.** Aligns with AGENTS.md and the checked-in trainer. 4 is no longer the right anchor. 8 stays as a post-baseline-freeze upgrade experiment per Section 14 (Warbird v2 roadmap).

### GARCH Engine — [RESOLVED]

```python
# GJR-GARCH with Student-t innovations
# Variant: GJR-GARCH (captures leverage effect — volatility responds
#   asymmetrically to negative vs positive shocks, critical for equity futures)
# Distribution: Student-t (fat tails in MES returns are real, not artifacts)
# Estimation window: Regime-anchored from January 20, 2025, expanding
#   ~290 trading days today, grows with regime
# Output: BOTH raw sigma and volatility ratio carried through evaluation
#   - Raw sigma: direct forecast
#   - Volatility ratio: GARCH forecast / realized vol (captures vol premium)
#   - Ablation determines which representation(s) survive
```

### What's NOT in v1 Model Stack

| Component | Status | When |
|-----------|--------|------|
| 15M ML model | [DEFERRED] | Phase 2 — after 1H model is stable and producing predictions that can feed as features |
| Setup outcome scorer | [DEFERRED] | Phase 3 — after setup count grows enough to support ML training |
| Monte Carlo simulation | [DEFERRED] | Phase 2 — layer on top of GARCH after GARCH is validated |
| Pinball loss (quantile regression) | [DEFERRED] | Phase 2/3 — training objective experiment after feature set is locked |

---

## 13. INFERENCE OUTPUT CONTRACT — VERSIONED

### WarbirdSignal Schema (v1)

```typescript
interface WarbirdSignal {
  // Metadata
  version: string                    // 'warbird-v1.0'
  generatedAt: string                // ISO timestamp
  symbol: string                     // 'MES'

  // Daily Layer
  daily: {
    bias: 'BULL' | 'BEAR' | 'NEUTRAL'        // 200d MA shadow
    price_vs_200d_ma: number                 // Distance in points
    distance_pct: number                     // Distance as percentage
    slope_200d_ma: number                    // Trend acceleration
  }

  // 4H Structure
  structure: {
    bias_4h: 'BULL' | 'BEAR' | 'NEUTRAL'
    agrees_with_daily: boolean
  }

  // Core Forecaster Output (1H)
  directional: {
    bias_1h: 'BULL' | 'BEAR' | 'NEUTRAL'
    price_target_1h: number          // Predicted price level
    price_target_4h: number          // Predicted price level
    mae_band_1h: number              // Expected adverse excursion
    mae_band_4h: number              // Expected adverse excursion
    mfe_band_1h: number              // Expected favorable excursion
    mfe_band_4h: number              // Expected favorable excursion
    confidence: number               // 0-1 calibrated confidence
  }

  // Conviction Assessment
  conviction: {
    level: 'MAXIMUM' | 'HIGH' | 'MODERATE' | 'LOW' | 'NO_TRADE'
    counter_trend: boolean           // Is this against the daily?
    all_layers_agree: boolean        // Daily + 4H + 1H + 15M
    runner_eligible: boolean         // Full conviction + with-trend
  }

  // Active Setup (when trigger has fired)
  setup?: {
    direction: 'BULL' | 'BEAR'
    fibLevel: number
    fibRatio: number
    entry: number
    stopLoss: number
    tp1: number
    tp2: number
    volume_confirmation: boolean     // Volume expansion on trigger
  }

  // Risk Context
  risk: {
    garch_vol_forecast: number
    garch_vol_ratio: number          // Forecast / realized
    gpr_level: number
    trump_effect_active: boolean
    vix_level: number                // Raw (not just percentile)
    vix_percentile_20d: number
    vix_percentile_regime: number
    regime: string                   // Current regime label
    days_into_regime: number
  }

  // GARCH Volatility Zones
  zones?: {
    zone_1_upper: number             // 1sigma boundary
    zone_1_lower: number
    zone_2_upper: number             // 2sigma boundary
    zone_2_lower: number
  }

  // Trade Feedback Context
  feedback: {
    win_rate_last20: number | null
    current_streak: number           // Positive = wins, negative = losses
    avg_r_recent: number | null
    setup_frequency_7d: number
  }
}
```

### Consumers

| Consumer | What It Reads | Current State |
|----------|--------------|---------------|
| `src/app/api/ml-forecast/route.ts` | Full signal object | Needs contract alignment |
| `src/components/MesIntraday/MLForecastTile.tsx` | Directional bias + confidence | Needs contract alignment |
| `public/ml-predictions.json` | Serialized predictions | Needs schema version field |
| Pine Script indicator (future) | Directional + zones + conviction | Not yet built — contract constrains design |

### Backward Compatibility
Existing payload fields preserved. New fields additive only. `version` field enables consumers to handle schema evolution.

---

## 14. PHASED ROADMAP — WARBIRD v1 -> v2 -> v3

### Warbird v1 (Current Scope)
- ONE ML model family: 1H core forecaster
- Rule-based layers: Daily 200d MA, 4H structure, 15M trigger, conviction matrix
- GARCH volatility engine (features + zones)
- Full feature engineering pipeline (P1-P5 + surprise z-scores + trade feedback + risk features)
- Regime-anchored features from Jan 20, 2025
- Unprecedented market design principles (dual-lookback, raw companions, no clipping)
- WarbirdSignal inference contract v1.0

### Warbird v2 (After v1 is Stable)
- 15M ML model: entry timing, 1H predictions as input features
- Monte Carlo simulation on top of validated GARCH
- Pinball loss experimentation (quantile regression)
- AutoGluon fold count upgrade (5 -> 8 with A/B comparison)
- RealMLP / TabM model additions (Option B from Research Report)
- Pine Script "The Rabid Raccoon" TradingView indicator

### Warbird v3 (After Setup Count Grows)
- Setup outcome scorer: P(T1), P(T2), P(Runner|T1)
- Time-to-target survival model
- FinBERT sentiment scoring on Fed communications + news
- Hyperparameter optimization (Option D)

---

## 15. BLOCKING ITEMS FROM ADJUDICATION — STATUS

| # | Blocking Item | Status | Resolution |
|---|--------------|--------|-----------|
| 1 | Geopolitical feature validity gate | ✅ RESOLVED | Risk features enter as model inputs with regime stability testing in comparison gate (Section 3, Rule 2) |
| 2 | Warbird-as-feature contract (not filter) | ✅ RESOLVED | AutoGluon learns interaction weights (Section 3, Rule 2) |
| 3 | Sequential training + memory guardrails | ✅ RESOLVED | sequential_local fold fitting, sequential symbol training on Apple Silicon (Section 12) |
| 4 | Numeric shadow promotion thresholds | ⏳ OPEN | Must define minimum sample window + MAE drift threshold. Structure agreed: min sample count AND min time window AND quantitative drift metric. Values calibrate from baseline. |
| 5 | GARCH spec lock | ✅ RESOLVED | GJR-GARCH, Student-t innovations, regime-anchored window from Jan 20, 2025, expanding. Both raw sigma and ratio carried through ablation. (Section 12) |

---

## 16. BACKFILL DEPENDENCIES — WHAT UNLOCKS WHAT

| Backfill Script | What It Unlocks | Cost | Priority |
|----------------|----------------|------|----------|
| `backfill-fred-releases.ts` | Official FRED release dates -> event timing features | Free | High |
| `backfill-trading-economics.ts` | 5yr actual/forecast/surprise -> **surprise z-scores (HIGHEST ROI)** | $49/mo | **CRITICAL** |
| `backfill-news-content.ts` | 3-5yr news articles -> enhanced news layer features, future FinBERT | $0-30/mo | Medium |
| `backfill-fed-statements.ts` | FOMC statements/minutes -> fed communication features | Free | Medium |
| GPR historical backfill | GeopoliticalRisk index history -> Warbird risk features | TBD | Required for Warbird |
| TrumpEffect historical backfill | Policy action signal history -> Warbird risk features | TBD | Required for Warbird |

**Total monthly data cost target:** ~$228-258/mo (Databento $179 + Trading Economics $49 + optional EODHD $30)

---

## 17. FOCUSED MISMATCH RESOLUTION

Instead of seven formal teardown workstreams, these are the specific mismatches that must be resolved before implementation proceeds. Focused, not comprehensive.

### Mismatch 1: Price Levels vs Returns — [RESOLVED -> ABLATION]
- **The gap:** Spec says price levels. `train-warbird.py` trains on returns.
- **Resolution:** Ablation test both representations on identical folds/features. Judge on downstream utility (T1/T2 alignment, MAE/MFE calibration, runner separation, confidence calibration) not just RMSE. **Inference output remains in price-space regardless** — the system speaks entry, stop, T1, T2, heat, runners. If returns win, a conversion layer maps to price-space at inference.
- **Blocks:** Nothing — ablation happens during training experimentation, not before.

### Mismatch 2: Fold Count — [RESOLVED -> 5 FOLDS]
- **The gap:** Memory said 4, AGENTS.md says max 5, trainer defaults to 5, plan says 8.
- **Resolution:** Locked at 5. Aligns with AGENTS.md and checked-in trainer. 8 stays as a post-baseline-freeze upgrade experiment (Warbird v2). AGENTS.md requires no change for fold count.
- **Blocks:** Nothing — resolved.

### Mismatch 3: Train-Serve Feature Gap
- **The gap:** `trade-features.ts` computes features in live scoring that don't exist in training datasets.
- **Action:** Audit and classify every live feature into (a) add to builder, (b) keep as post-model adjustment, (c) remove as redundant.
- **Blocks:** Feature set finalization.

### Mismatch 4: BHG -> Warbird Naming Transition
- **The gap:** Schema and some runtime files still use BHG. New scaffolding maps back to legacy storage.
- **Action:** Complete rename as additive-only migration. No destructive changes until validated.
- **Blocks:** Nothing (transition is in progress, not stalled).

### Mismatch 5: 1m Dataset Classification
- **The gap:** Previously labeled "minimal and maybe dead" but actually carries FRED, GPR, Trump, calendar, news, multi-horizon targets.
- **Action:** Re-evaluate with accurate description. Decide keep (for micro-pullback volume analysis) or kill.
- **Blocks:** Nothing critical.

### Mismatch 6: AG Config Drift (Stack Levels + Excluded Models)
- **The gap:** This spec locks `num_stack_levels=1` and excludes `KNN`, `FASTAI`, `RF`. `AGENTS.md` is now aligned, but `train-warbird.py` (lines 67-71) still says `num_stack_levels=2` and has no excluded model types.
- **Action:** Sync `train-warbird.py` to match this spec's canonical config. `num_stack_levels=1` (2+ rarely helps, adds significant training time). Exclusions confirmed as waste compute on this dataset.
- **Blocks:** Training config consistency. Must sync before any training runs against this spec.

### Mismatch 7: Model Family Implementation Drift
- **The gap:** Warbird v1 is ONE model family (1H core forecaster with six target-specific predictors). `AGENTS.md` is aligned to that governance, but checked-in training code and legacy supporting docs still need to reflect the one-family / six-predictor v1 contract.
- **Action:** Refactor the trainer and related training docs to match the v1 one-family architecture. Broader multi-model expansion remains a Phase 2/3 path, not v1 scope.
- **Blocks:** Trainer and training-doc consistency.

---

## 18. WHAT'S EXPLICITLY NOT IN SCOPE (Warbird v1)

- **15M ML model** — deferred to Phase 2. 1H model must be stable first.
- **Setup outcome scorer ML model** — deferred to Phase 3. Needs more setup data.
- **Monte Carlo simulation** — deferred to Phase 2. GARCH first.
- **Pinball loss** — deferred to Phase 2/3. Training objective experiment after features locked.
- **FinBERT sentiment scoring** — deferred to Phase 3. Start with rule-based hawk/dove.
- **RealMLP / TabM model additions** — deferred to Phase 2 after features stabilized.
- **Hyperparameter optimization** — deferred to Phase 3 after architecture locked.
- **Extreme quality preset (GPU)** — not viable on Apple Silicon.
- **Per-symbol expansion beyond MES** — Warbird is MES-first.

---

## 19. DECISION LOG

| Date | Decision | Rationale | Authority |
|------|----------|-----------|-----------|
| 2026-03-13 | Warbird = engine, Rabid Raccoon = platform | Clear architectural boundary | Kirk |
| 2026-03-13 | BHG -> Warbird rename in progress (additive) | Naming consistency | Kirk |
| 2026-03-13 | Volume is first-class for T2/runner decisions | Trading methodology — 25 years | Kirk |
| 2026-03-13 | Warbird risk layer = feature, not filter | Let AutoGluon learn interaction weights | Kirk + Claude |
| 2026-03-13 | GARCH = GJR-GARCH, Student-t, regime-anchored | Adjudication blocking item | Kirk + Claude |
| 2026-03-13 | Both GARCH representations through ablation | Non-essential to force one at day zero | Kirk |
| 2026-03-13 | Surprise z-scores = highest ROI feature | CME 2025 research | Research |
| 2026-03-14 | Daily 200d MA = directional shadow, required | The line in the sand every desk watches | Kirk |
| 2026-03-14 | 4H = trend/structure only, NO fib geometry | 4H fibs too wide for 20-40pt day trades | Kirk |
| 2026-03-14 | 1H = where fibs live, where trades are identified | Matches 20-40pt+ target, multiple opps per session | Kirk |
| 2026-03-14 | 15M = entry trigger confirmation (rule-based in v1) | Confirms 1H opportunity with candle/volume/stoch | Kirk |
| 2026-03-14 | Regime anchor = January 20, 2025 | Current policy regime start — features normalize to THIS environment | Kirk |
| 2026-03-14 | Training data = full 2 years, regime FEATURES from Jan 20 | Model sees both regimes, knows which one it's in | Kirk + Claude |
| 2026-03-14 | Warbird v1 = ONE ML model family (1H core forecaster) | Reduce complexity 3x. Ship simple, prove it, then layer. | Kirk + Claude |
| 2026-03-14 | 15M model, setup scorer, MC, pinball = DEFERRED | Foundation must work before adding complexity | Kirk + Claude |
| 2026-03-14 | Unprecedented market principles: dual-lookback, raw companions, no clipping | Record moves must reach the model uncompressed | Kirk + Claude |
| 2026-03-14 | Fold count = 5 | Aligns with AGENTS.md + trainer; 8 stays as v2 upgrade experiment | Kirk |
| 2026-03-14 | Price levels vs returns = ABLATION, inference stays price-space | Test both on identical folds; judge on T1/T2 alignment, MAE calibration, runner separation | Kirk |
| 2026-03-14 | AG config drift flagged: stack_levels + excluded models must sync | Spec canonical; AGENTS.md aligned and trainer must align to num_stack_levels=1, exclude KNN/FASTAI/RF | Kirk + Agent Review |
| 2026-03-14 | Model family contract locked for v1 | AGENTS.md aligned to one-family v1; trainer/docs must follow, broader multi-model path is v2/v3 | Kirk + Agent Review |
| 2026-03-14 | Post-entry volume classification locked | `micropullback_vol_pattern`, `vol_profile_at_tp1`, and `vol_trend_post_trigger` are trade-management features, not pre-entry core-forecaster inputs | Kirk + Agent Review |

---

## 20. APPROVED ADDITIVE SCAFFOLDING — ACKNOWLEDGED

The following additive Warbird scaffolding has been approved and implemented via 0C slices. This spec acknowledges their existence — they are not in conflict with the "target-state" nature of this document.

- `warbird-setup-recorder.ts` — additive recorder mapping to legacy BHG storage during transition
- `warbird-master-tasklist.md` — approved task tracking
- Related 0C approved scaffolding documented in `2026-03-13-warbird-master-tasklist.md` (lines 488-553)

These are foundation pieces that the target architecture builds on, not artifacts that need to be torn down.

---

*This spec is the canonical target-state reference for the Warbird engine architecture. It clearly distinguishes between current repo reality, target state, and resolved mismatches. Agents execute against it with the understanding that [TARGET] items are what we're building toward, [MISMATCH] items must be synced after placement, and [DEFERRED] items are explicitly not in v1 scope. One open blocking item remains: shadow promotion thresholds (#4). All other items are resolved.*
