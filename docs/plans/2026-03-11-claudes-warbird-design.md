# Claude's Warbird Design
**Date:** 2026-03-11
**Status:** Approved design, awaiting implementation kickoff
**Author:** Claude + Kirk collaborative brainstorm

---

## Vision

Three systems, one decision loop:

```
┌─────────────────────────────────────────────────────────────────┐
│                    KIRK'S DECISION LOOP                         │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  DASHBOARD    │    │  WARBIRD ML  │    │  TRADINGVIEW  │     │
│  │  (command     │◄───│  (brain)     │    │  (execution   │     │
│  │   center)     │    │              │    │   surface)    │     │
│  │              │    │  1h/4h price  │    │              │      │
│  │  Regime state │    │  MAE zones   │    │  AF Struct+IM │     │
│  │  Correlation  │    │  MFE zones   │    │  Fib levels   │     │
│  │  News/events  │    │  Direction   │    │  Break/Accept │     │
│  │  Volume state │    │  Confidence  │    │  Regime tint  │     │
│  │  ML forecast  │    │              │    │  News proxy   │     │
│  └──────┬───────┘    └──────────────┘    └──────┬───────┘      │
│         │                                        │              │
│         │◄──── webhook alerts (AC+, RJ, PB) ─────┘              │
│         │                                                       │
│         └──── webhook zones (MAE/MFE bands) ────►TV overlay     │
│                                                  (Phase 2)      │
└─────────────────────────────────────────────────────────────────┘
```

- **Dashboard (Rabid Raccoon)** = command center. Shows ML predictions, regime, correlations, news state, volume. Where decisions are made.
- **TradingView (AF Struct+IM)** = execution surface. Draws Fibs, detects structure events, scores intermarket, fires alerts. Kirk has TradingView Premium (webhooks available).
- **Warbird ML** = the brain. Price direction confirms Fib bias, MAE sets stop floor, MFE validates if 1.236/1.618 targets are reachable.

### The Bridge (two directions)

1. **TV → Dashboard**: TradingView alert webhooks on AC+/AC-/RJ/PB/NEWS events → `/api/tv-webhook` → dashboard logs event, enriches with ML context
2. **Dashboard → TV (Phase 2)**: Warbird zones pushed via webhook → Pine Script reads → overlays ML zones directly on chart

---

## ML Role: Confirmation, Not Replacement

Kirk's system is ~90% deterministic rules, ~10% ML support:

| Component | Owner | ML Role |
|---|---|---|
| Entry level | Fib 0.786/0.618/0.500 pullback (deterministic) | N/A |
| Direction bias | Intermarket regime score (deterministic) | 1h price prediction confirms |
| Stop placement | Below Fib pullback zone | MAE prediction sets worst-case floor |
| Profit targets | Fib 1.236 and 1.618 (always) | MFE prediction validates if targets are reachable |
| Trigger | All 6 filters green (deterministic) | ML is one of the 6 filters |
| Volume | Live volume behavior | Volume features in training dataset |
| Correlations | NQ/BANK/VIX/DXY/US10Y alignment | Alignment score from trained model |

### Entry Filter (ALL must pass)

1. Fib pullback positioning (0.786/0.618/0.500) — from AF Struct+IM
2. ML price direction alignment — from Warbird 1h model
3. Correlation alignment (score > 60) — from correlation set
4. Volume favor (dominant order flow) — from volume features
5. Technical indicators aligned (MACD, RSI, CM Ultimate) — from chart
6. Whipsaw risk check (LOW or MEDIUM only) — from volume + price action

---

## Warbird V2 Training Configuration

### Horizons and Targets

| Horizon | Bar Count | Purpose | eval_metric |
|---|---|---|---|
| 1h | 1 bar forward | Directional bias for entry confirmation | `mean_absolute_error` (price), `root_mean_squared_error` (MAE/MFE) |
| 4h | 4 bars forward | Swing bias for target validation | same split |

- 3 targets per horizon: price return, MAE (max adverse excursion), MFE (max favorable excursion)
- **6 models total** (2 horizons x 3 targets)
- Target derivation: `(close[i+h] - close[i]) / close[i]` with one-step lookahead guard

### Why 1h/4h and not 15m

Kirk's AF Struct+IM indicator uses:
- 5m/15m for Fib structure events (break/accept/reject) — these are **deterministic**, no ML needed
- 1h for intermarket confirmation (EMA trends on NQ/BANK/VIX/DXY/US10Y)
- 4h for daily swing bias

A 15m ML model would restate what the Fib structure already shows. Zero value add, 50% more training time.

### AutoGluon Settings (Research-Backed)

```python
AG_SETTINGS = {
    'presets': 'best_quality',
    'num_bag_folds': 5,                    # AGENTS.md hard rule
    'num_stack_levels': 2,
    'dynamic_stacking': False,             # Walk-forward CV handles leakage; saves 25% time
    'excluded_model_types': [],            # All ~100 zeroshot configs included
    'ag_args_fit': {
        'num_early_stopping_rounds': 50,
        'ag.max_memory_usage_ratio': 0.8,
    },
    'ag_args_ensemble': {
        'fold_fitting_strategy': 'sequential_local',  # CPU-bound, 1 fold at a time
    },
}
```

**Key research findings applied:**
- `dynamic_stacking=False` — AutoGluon 1.5 reserves 25% of time_limit for stacked overfitting detection (PR #3616, 74% balanced accuracy). Walk-forward CV with purge/embargo already covers this. Saves ~1.5 days.
- Split eval_metric — MAE for price returns (fat-tail robust per Hyndman & Athanasopoulos), RMSE for excursion targets (penalizes large errors on extreme predictions).
- `sample_weight` with exponential decay — halflife=180 days. Recent bars weighted ~3x vs oldest. Keeps full 2-year regime diversity while emphasizing current market structure.

### AutoGluon 1.5 Model Zoo (what best_quality runs)

~100 model configurations across 15+ families (TabRepo zeroshot portfolio):
- **GBMs**: LightGBM, CatBoost, XGBoost (dominant performers)
- **Neural nets**: TabularNeuralNet (PyTorch), FastAI, RealMLP, TabM
- **Foundation models**: MITRA, TabICL, TabPFNv2
- **Trees**: Random Forest, Extra Trees
- **Interpretable**: EBM (Explainable Boosting Machine), KNN, Linear/Ridge
- **Meta**: WeightedEnsemble (greedy ensemble selection)

With 2 stack levels: L1 trains all configs on raw features, L2 trains on L1 OOF predictions + raw features (skip connections), meta-layer combines via ensemble selection.

### Training Parameters

| Parameter | Value | Rationale |
|---|---|---|
| Lookback | 2 years (~10,400 1h rows) | Above TabRepo median (3,800). Walk-forward + per-fold IC ranking handles stale regimes. |
| Base resolution | 1h rows | Matches intermarket timeframe |
| 1m features | Rolled up per hour | MES microstructure (RVOL, VWAP, POC, VAH, VAL) as feature columns |
| Symbols | All 16 active | MES + ES, NQ, RTY, SOX, SR3, YM, GC, SI, 6E, 6J, CL, NG, ZB, ZF, ZN |
| Raw features | ~230 columns | Pruned to 30/fold by IC + cluster dedup |
| sample_weight | Exponential decay, halflife=180d | Recent data weighted ~3x vs oldest |
| Seed | 42 | Reproducibility |
| CPUs | 11 (of 12) | 1 reserved for system |
| Price time_limit | 14,400s (4h/fold) | Generous for 10K rows x 230 features |
| Risk time_limit | 7,200s (2h/fold) | Adequate for MAE/MFE |
| Feature top-N | 30 per fold | IC ranking + hierarchical cluster dedup |r| > 0.85 |
| Purge/embargo | Auto-computed per horizon | 1h: 75 row gap, 4h: 141 row gap |
| MC paths | 10,000 | Monte Carlo zone computation |
| Estimated training | ~5-6 days | Sequential on M4 Pro, 24GB RAM |

### Dataset: `build-warbird-dataset.ts`

**Output**: `datasets/autogluon/mes_warbird_2y.csv`

| Feature Group | Source | Columns (est.) |
|---|---|---|
| MES price/technicals | `mkt_futures_mes_1h` | ~22 |
| MES 1m microstructure | `mkt_futures_mes_1m` rolled up/hour | ~15 |
| Volume features (full) | `mkt_futures_mes_1m` (RVOL, VWAP, POC, VAH, VAL, profile shape) | ~10 |
| Cross-asset technicals | `mkt_futures_1h` (15 symbols x 6 features) | ~90 |
| FRED macro + derived | 10 `econ_*_1d` tables (36 core series) | ~48 |
| Geopolitical/policy | `geopolitical_risk_1d`, `trump_effect_1d` | ~7 |
| News/events | `econ_calendar`, `news_signals`, news tables | ~14 |
| Volatility regime | Derived (Squeeze Pro, WVF, vol_accel, vol_of_vol) | ~8 |
| Cross-asset correlations | Derived (21d rolling, concordance) | ~6 |
| BHG outcome history | `bhg_setups` (rolling hit rates) | ~10 |
| sample_weight | Exponential decay column | 1 |
| **Total** | | **~231** |

### Walk-Forward CV with Purge/Embargo

```
purge  = (horizon_bars - 1) + feature_max_lookback(24)
embargo = purge x 2

1h horizon:  purge=25, embargo=50, total gap=75 rows
4h horizon:  purge=27, embargo=54, total gap=81 rows
```

5 folds, strictly chronological (no shuffle). Each fold validates on future data. Per-fold feature selection ensures features that lose relevance in newer regimes get pruned.

---

## Dashboard Integration: Warbird Forecast Response

```typescript
interface WarbirdForecast {
  timestamp: string;
  h1: {
    price: { q10: number; q50: number; q90: number };  // Forward return quantiles
    mae: { q10: number; q50: number; q90: number };    // Worst drop quantiles
    mfe: { q10: number; q50: number; q90: number };    // Best gain quantiles
  };
  h4: {
    price: { q10: number; q50: number; q90: number };
    mae: { q10: number; q50: number; q90: number };
    mfe: { q10: number; q50: number; q90: number };
  };
  h1_direction: 'BULLISH' | 'BEARISH';
  h1_confidence: number;  // 0-1, from prediction sigma spread
  h4_swing_bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  meta: {
    generated_at: string;
    model_dir: string;
    n_folds: number;
    vol_method: 'GARCH' | 'EWMA';  // Logged per research finding
  };
}
```

### Entry Evaluation (Dashboard Side)

```typescript
function evaluateFibEntry(
  fibEvent: 'BREAK' | 'ACCEPT' | 'REJECT',
  fibDirection: 'BULL' | 'BEAR',
  regimeScore: number,
  mlForecast: WarbirdForecast
): EntrySignal | null {

  // Step 1: Fib structure must trigger (from TV alert webhook)
  if (fibEvent !== 'ACCEPT') return null;

  // Step 2: Regime must align (intermarket score > 67%)
  if (regimeScore < 67) return null;

  // Step 3: ML confirms direction (1h bias)
  const mlAligned = (
    (fibDirection === 'BULL' && mlForecast.h1_direction === 'BULLISH') ||
    (fibDirection === 'BEAR' && mlForecast.h1_direction === 'BEARISH')
  );
  if (!mlAligned) return null;

  // Step 4: Targets must be realistic (MFE vs Fib targets)
  const fib1236distance = Math.abs(getFibLevel(1.236) - currentPrice);
  if (Math.abs(mlForecast.h1.mfe.q90) < fib1236distance) {
    return null;  // MFE can't reach 1.236 — skip trade
  }

  // Step 5: Set stop based on MAE
  const stop = currentPrice + mlForecast.h1.mae.q10 - 1.0;

  return {
    entry: currentPrice,
    stop,
    tp1: getFibLevel(1.236),
    tp2: getFibLevel(1.618),
    direction: fibDirection,
    ml_confidence: mlForecast.h1_confidence,
    regime_score: regimeScore,
  };
}
```

---

## Phased Execution Plan

### Phase 0 — TONIGHT: Train Warbird V2
- Create `build-warbird-dataset.ts` (16 symbols, all volume, all FRED, GPR, Trump, 1m microstructure, sample_weight column)
- Update `train-warbird.py` (1h/4h horizons, split eval_metric per target type, dynamic_stacking=False, sample_weight support)
- Build dataset, validate, kick off training (~5-6 days unattended on M4 Pro)
- Pre-flight: close Ollama, verify .venv-finance has AutoGluon, verify dataset quality

### Phase 1 — WHILE TRAINING: Indicator Review + Backtest
- Code review AF Struct+IM Pine Script (~600 lines)
- Backtest Fib confluence accuracy across historical MES data
- Document edge cases, false signals, parameter sensitivity
- Identify improvements to Fib anchoring, intermarket weights, news proxy thresholds

### Phase 2 — AFTER TRAINING: Serving + Dashboard
- Create `predict-warbird.py` (regression inference, zone computation)
- Create `/api/warbird-forecast` route (serves WarbirdForecast JSON)
- Monte Carlo zone computation (10K paths, GJR-GARCH vol)
- Pinball loss calibration (q10/q50/q90 quantiles)
- Update `MLForecastTile.tsx` → show MAE/MFE bands + 1h direction + 4h swing bias
- Write training results to `mes_model_registry` table
- Pin `requirements-warbird.txt` with exact versions

### Phase 3 — INTEGRATION: TV ↔ Dashboard Bridge
- Create `/api/tv-webhook` endpoint → receives TradingView alert webhooks (AC+, RJ, PB, NEWS events)
- Dashboard trade log → records every TV alert with ML context snapshot at time of alert
- Entry evaluation function → all 6 filters visible in one dashboard view
- Inngest function to run `predict-warbird.py` on schedule (every 4h, weekdays)

### Phase 4 — OVERLAY: ML on TradingView Charts
- Pine Script library receives Warbird zones via webhook data
- MAE/MFE rendered as translucent horizontal bands on chart (matching AF Struct+IM zone style)
- Direction arrow + confidence badge overlay
- Full loop: TV fires alert → dashboard enriches → dashboard pushes zones back to TV

---

## AF Struct+IM Indicator Summary (for review in Phase 1)

Kirk's Pine Script v6 indicator (AF Struct+IM) implements:

### AutoFib Engine
- Multi-period Fibonacci confluence: 8/13/21/34/55 bar lookback windows
- Confluence scoring across all 5 periods (tolerance-based matching at 0.382/0.500/0.618)
- Highest-scoring period anchors the Fib levels
- Structural break detection: close exceeds locked range → re-anchor

### Structure Levels
- **Pivot**: 0.500
- **Decision Zone**: 0.618–0.786 (entry pullback zone)
- **Targets**: 1.236 and 1.618 (profit targets)
- **Down Magnets**: 0.382 and 0.236 (downside support)

### Intermarket Model (Score + Hysteresis)
- 5 symbols: NQ (weight 10), VIX (7), BANK (3), DXY (3), US10Y (2)
- 1h EMA trend detection with neutral band
- Score threshold: 67% of total weight
- Requires NQ + BANK anchor alignment
- Regime flip: 2 bars confirmation, 3 bars cooldown
- VIX max risk-on filter: 20.40

### News Proxy (5m Shock Detection)
- Cross-asset shock reaction as proxy for macro news
- NQ shock: 0.25%, DXY shock: 0.10%, VIX shock: 4%, US10Y shock: 0.03 (3 bps)
- Minimum proxy score: 3 of 4 must trigger
- Posture hold: 12 bars after detection

### Structure Events
- **Break**: Close crosses zone boundary (direction-aware)
- **Accept**: Break then retest-hold within 6 bars
- **Reject**: Wick into zone then close back out
- **Pivot Break**: Close crosses pivot against Fib direction

---

## Research Citations

- AutoGluon 1.5.0 TabularPredictor docs: https://auto.gluon.ai/stable/api/autogluon.tabular.TabularPredictor.fit.html
- TabRepo paper (zeroshot portfolio): arXiv:2311.02971
- Dynamic Stacking PR #3616: https://github.com/autogluon/autogluon/pull/3616
- Lopez de Prado, Advances in Financial Machine Learning (purge/embargo CV)
- Neural Nets vs Boosted Trees on Tabular Data: arXiv:2305.02997
- Hyndman & Athanasopoulos, Forecasting: Principles and Practice (MAE vs RMSE)

---

*Saved: 2026-03-11 ~10:30 PM CT*
*Next action: Kirk picks up → implementation plan → build dataset → start training*
