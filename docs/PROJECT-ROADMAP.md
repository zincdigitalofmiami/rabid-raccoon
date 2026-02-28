# Rabid Raccoon — Project Roadmap & Architecture
## MES Futures Trading Intelligence Platform
**Last Updated:** February 20, 2026
**Architect:** Kirk (Zinc Digital)
**Assistant:** Claude (furry, caped)

---

## VISION

Build a **statistically-backed MES trading intelligence system** that combines:
1. An ML directional model for hourly/4h bias
2. A statistical backtesting engine proving every indicator, pressure map state, and event reaction with real sample sizes
3. A single-page "Command Center" dashboard that displays actionable, historically-grounded scenarios before each session
4. TradingView indicator settings validated by MES-specific backtests
5. A custom "Rabid Raccoon Indicator" for TradingView that surfaces the system's signals directly on the chart

The guiding principle: **every number shown to Kirk has a verifiable sample size (n=X) and no black box.** This is empirical market research, not prediction magic.

---

## PART 1: ML DIRECTIONAL MODEL

### What It Does
Binary classification: "Will MES be higher or lower in 1h / 4h?" Output is a probability (0-1) that feeds into the dashboard as one signal among many.

### Current Status (Feb 20, 2026)
- **Phase 1 training launched** — Classification mode, 2 walk-forward folds, 600s/fold
- **Dataset:** 36,040 rows × 144 columns (2020-01 to 2026-02), 1h bars
- **Usable features:** ~128 after deduplication and zero-variance removal
- **Targets:** target_dir_1h (51.4% up base rate), target_dir_4h (53.3% up base rate)
- **Eval metric:** ROC-AUC (target: >0.52 = real signal, >0.55 = tradeable)

### Key Decisions Made
- **Classification over Regression** — Raw return prediction was a coin flip (50.6% accuracy, predictions compressed to near-zero). Direction prediction is the right question for trading.
- **Walk-Forward Validation** — Expanding window folds, never random splits. Purge gap prevents label overlap. The model never sees the future.
- **5 Redundant Features Removed** — yield_proxy (=zn_ret_1h), usd_shock (=e6_ret_1h), econ_surprise_index (=claims_release_z), bhg_setups_count_30d (=7d), news_total_volume_7d (=policy_news_volume_7d)
- **Global dropna Bug Fixed** — Old code dropped rows missing ANY target across ALL horizons. Now each horizon drops only its own NaN targets inside the per-fold loop.
- **Winsorization** — All 118 numeric features clipped to 1st-99th percentile to prevent outlier dominance.

### Phase 1 Settings (Fast Validation)
- Preset: high_quality_v150
- Folds: 2 walk-forward
- Time limit: 600s/fold
- Models: LightGBM, CatBoost, XGBoost, ExtraTrees
- Excluded: KNN (curse of dimensionality), FASTAI (crashes on Apple Silicon), RF (redundant with XT), NN_TORCH (overfits, eats memory)
- Bagging: 0, Stacking: 0
- Runtime: ~20-40 minutes

### Phase 2 Settings (Production — after Phase 1 validates)
- Preset: best_quality_v150
- Folds: 3 walk-forward
- Time limit: 2,400s/fold
- Bagging: 3-fold internal
- Stacking: 1 level
- Runtime: ~4-6 hours

### Success Criteria
| Metric | Coin Flip | Minimum Signal | Tradeable |
|--------|-----------|----------------|-----------|
| AUC | 0.500 | > 0.520 | > 0.550 |
| Accuracy | 51.4% (base rate) | > 52.5% | > 54% |
| High-Confidence Accuracy | 50% | > 55% | > 58% |

### After Training
1. Evaluate OOF results — beat coin-flip? Which horizon stronger?
2. Feature importance — which of ~128 features actually matter? Prune dead weight.
3. Phase 2 production run if Phase 1 shows signal.
4. Model output becomes ONE input to the Command Center dashboard — not the primary decision-maker.

---

## PART 2: STATISTICAL BACKTESTING ENGINE

This is the core intellectual property. NOT ML prediction — it's a **giant lookup table** built from 2-5 years of real MES data. Every claim has an N, every probability has a sample size.

> "When RSI(14) on 15m crossed below 30 AND all 4 indices were bearish AND VIX was in the 75th percentile AND CPI was dropping in 2 hours — here's what happened 847 times over the last 4 years: 67% of the time MES dropped 12+ points in the next hour. Average move: -14.3 pts. Average max adverse excursion: 6.2 pts."

This is exactly what Edgeful does for Initial Balance, what the NQ Statistical Mapping indicator does with 12 years of data, and what institutional desks build internally — but for Kirk's specific instrument, indicators, and trading style.

### Three Backtesting Layers

#### Layer 1: Indicator Signals on MES

Every indicator tested with specific settings against actual MES forward returns. Output per combination:
- Occurrences (n), win rate, avg return, median return
- MAE (max adverse excursion), MFE (max favorable excursion), R-multiple
- Best/worst time-of-day, best/worst session
- Verdict: USEFUL / NOT USEFUL / CONDITIONAL

**Tier 1 — Strong Evidence (test first):**
| Indicator | Settings to Test | Timeframes | Why |
|-----------|-----------------|------------|-----|
| VWAP + SD Bands | Session anchor 6pm ET, 1/2/3 SD | 5m, 15m | Institutional benchmark. Distance from VWAP as % of ATR → forward return |
| Volume Profile (Session) | POC, VAH, VAL, 70% value area | 5m, 15m RTH | Price at POC vs away → mean reversion probability |
| Initial Balance | First 30min range, first 60min range | 5m, 15m | IB break direction → continuation rate. 12 years of NQ data shows 65-75% |
| ATR | 7, 14, 20 | 15m, 1h | Regime filter: trades when ATR > 20-day avg vs below → win rate difference |
| RSI | 7, 9, 14, 21 | 5m, 15m, 1h | RSI <30, >70, divergence, crossing 50 — each a different signal |
| Stochastic RSI | K:14/D:3, K:9/D:3, K:21/D:7 | 5m, 15m | Already used in BHG. Which K/D has highest accuracy for entry timeframe |

**Tier 2 — Moderate Evidence (test second):**
| Indicator | Settings to Test | Timeframes | Why |
|-----------|-----------------|------------|-----|
| EMA Crossovers | 9/21, 8/21, 12/26 | 15m, 1h | Which pair catches trend changes fastest with fewest whipsaws |
| MACD | 12/26/9, 5/13/1, 8/17/9 | 15m, 1h | Histogram direction change → forward return. Also divergence |
| ADX | 7, 14, 20 | 15m, 1h | "Is there a trend?" Trades when ADX >25 vs <20 → win rate |
| Bollinger Bands | (20,2), (20,1.5), (10,2) | 15m, 1h | Band touch → bounce rate. BB squeeze → breakout rate |
| OBV Slope | 10-bar, 20-bar regression | 15m | OBV confirming vs diverging → continuation rate |
| CCI | 14, 20 | 15m, 1h | Extreme readings >100 / <-100 → reversal probability |

**Tier 3 — Test only if Tier 1-2 show signal:**
Ichimoku cloud cross, Fibonacci retracements (0.618 vs 0.786), Pivot Points, Donchian Channel, Williams %R

**Skip entirely:** SMA crossovers, Keltner Channels, Rate of Change, Momentum oscillator, any "AI" or "smart money" community indicators without transparent math.

#### Layer 2: Pressure Map (Cross-Market State)

Define discrete market states from cross-asset data, then test MES outcomes conditional on each state. This is the existing dashboard concept — but backed by actual statistics.

**State Variables:**
| Variable | States | Source |
|----------|--------|--------|
| Index Alignment | 4/4 bullish, 3/4, 2/4, 3/4 bearish, 4/4 bearish | ES, NQ, YM, RTY 1h direction |
| VIX Regime | Low (<15), Normal (15-20), Elevated (20-25), High (>25) | VIX level |
| VIX Direction | Rising (>1pt/day), Flat, Falling (>1pt/day) | VIX 1-day change |
| Bond Direction | Bullish (ZN up), Flat, Bearish (ZN down) | ZN 1h return |
| Dollar Direction | Strengthening, Flat, Weakening | DXY 1-day change |
| Gold Signal | Risk-off (GC up + ES down), Neutral, Risk-on | GC vs ES direction |
| Volume Regime | Above avg, Normal, Below avg | MES volume vs 20-day avg for time-of-day |

**Method: Hierarchical filtering.** Start with the most important variable (Index Alignment), test MES forward returns. Then add VIX Regime as second filter. Keep adding filters until sample size drops below ~100 — then stop, the probability isn't reliable.

**Example output:**
```
PRESSURE MAP STATE: 4/4 indices bearish + VIX elevated (20-25) + VIX rising
PERIOD: Jan 2021 — Feb 2026
OCCURRENCES: 287

MES Forward Return (4h):
  Average: -11.4 pts | Median: -8.7 pts
  Win rate (short): 63.8%
  
  Combined with Bond Direction:
    + ZN bullish (flight to safety): 71.2% bearish (n=94) ← STRONG SIGNAL
    + ZN flat: 61.3% bearish (n=112)
    + ZN bearish (everything selling): 58.4% bearish (n=81) ← weaker
```

#### Layer 3: Event Proximity + Reaction

Where the real alpha lives, per CME Group's own research.

**Pre-Event (what Kirk sees at 5 AM when CPI is at 8:30 AM):**
- Historical MES behavior in the 0-4 hour window BEFORE release (range compression, volume drop, direction bias)
- Scenario maps: what happened when actual came in hot / inline / cool, with probabilities and sample sizes

**Post-Event (after the number drops):**
- First 30min reaction, 1h reaction, 4h reaction
- Cross-referenced with current pressure map state
- Partial reversal rate (how often does the initial move fade?)
- Reaction alignment: did the market respond intuitively or counter-intuitively?

**Event Impact Hierarchy (from CME Group 2025 research):**
| Tier | Events | Avg Volume Surge |
|------|--------|-----------------|
| Tier 1 | NFP, FOMC, CPI (core + headline) | +990K equity futures |
| Tier 2 | Retail Sales, GDP, PPI, PCE | +400-600K |
| Tier 3 | PMI, Jobless Claims, Consumer Sentiment | +100-300K |

**Requires:** Trading Economics API ($49/mo) for 5-year backfill of actual/forecast/surprise with release timestamps.

---

## PART 3: RABID RACCOON COMMAND CENTER (Dashboard)

Single-page dashboard replacing the current two-page layout. Every panel backed by backtested statistics.

```
┌─────────────────────────────────────────────────────────────────┐
│  RABID RACCOON COMMAND CENTER          Fri Feb 20, 2026 7:15AM │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  SESSION BIAS: BEARISH 63%  (n=287 matching scenarios)         │
│  ████████████████████░░░░░░░░  confidence: MODERATE            │
│                                                                 │
├──────────────────────┬──────────────────────────────────────────┤
│  PRESSURE MAP        │  EVENT TIMELINE                          │
│                      │                                          │
│  NQ  ▼ -0.28% ✓     │  ██ 08:30 GDP Q4 2nd    [HIGH]         │
│  YM  ▼ -0.15% ✓     │  ██ 08:30 Core PCE Dec  [HIGH]         │
│  RTY ▼ -0.31% ✓     │  ░░ 08:30 Personal Inc  [MED]          │
│  VIX  20.8 74th pctl│  ░░ 10:00 Home Sales    [LOW]          │
│  ZN  ▲ +0.12% ⚠     │  ░░ 10:00 UMich Sent    [MED]          │
│  GC  ▲ +0.18% ⚠     │                                          │
│  DXY  flat           │  PCE SCENARIO MAP:                       │
│                      │  0.3% (hot) → ▼18pts avg (n=14, 72%)   │
│  Alignment: 4/4 BEAR│  0.2% (inline) → ±4pts (n=22, 51%)     │
│  State: RISK-OFF     │  0.1% (cool) → ▲15pts avg (n=12, 68%) │
│  Historical: 63.8%   │                                          │
│  bearish next 4h     │  ⚠ PRE-EVENT: Expect compressed range   │
│  (n=287)             │  until 8:30. Volume -23% vs normal.      │
│                      │  Don't force entries.                     │
├──────────────────────┴──────────────────────────────────────────┤
│  INDICATOR SIGNALS (backtested, MES-specific)                   │
│                                                                 │
│  VWAP: Price BELOW session VWAP by 0.6 ATR                    │
│  → Bearish bias. 61% stays below rest of session (n=1,890)    │
│                                                                 │
│  RSI(14) 15m: 42.3 — neutral zone, no signal                  │
│                                                                 │
│  Stoch RSI 15m: approaching oversold (K:18)                   │
│  → If crosses below 20: 57% bounce within 4 bars (n=2,100)   │
│  → BUT: in risk-off pressure state, bounce rate drops to 49%  │
│                                                                 │
│  Initial Balance: not yet formed (pre-RTH)                     │
│  → IB breaks bearish 59% of time when overnight gap down       │
│    and indices aligned bearish (n=203)                          │
│                                                                 │
│  Volume: 78% of normal for 7:15 AM — THIN, waiting for data   │
│  ADX(14) 1h: 31.2 — trending. Favor continuation over reversal│
├─────────────────────────────────────────────────────────────────┤
│  BHG REGIME                                                     │
│  Win rate (last 20): 55% | Bull: 60% | Bear: 48%              │
│  Avg R: 1.4 | Streak: W-W-L-W-L                               │
│  Setups/7d: 8 (active, trending market)                        │
│  → Longs outperforming shorts in this regime                   │
│  → But pressure map says bearish — CONFLICT. Size down.        │
├─────────────────────────────────────────────────────────────────┤
│  TRADINGVIEW INDICATOR CHEAT SHEET (backtested on MES)         │
│                                                                 │
│  Best confirmed performers (>57% win rate, n>500):             │
│  1. VWAP + 2SD band touch → mean reversion (61%, n=890)       │
│  2. IB breakout + retest → continuation (63%, n=614)           │
│  3. RSI(14) <25 on 15m during RTH AM → bounce (59%, n=487)    │
│  4. Volume Profile POC rejection → reversal (58%, n=1,203)    │
│  5. ADX>25 + EMA9/21 cross on 1h → trend entry (57%, n=723)  │
│                                                                 │
│  Settings that FAILED on MES (<52% or <200 occurrences):       │
│  ✗ MACD histogram crossover on 5m (51.2%, n=4,200 — noise)   │
│  ✗ Bollinger Band touch on 5m (50.8%, n=3,100 — too fast)     │
│  ✗ RSI(7) on 5m (52.1% but MAE too high — stopped out often) │
│  ✗ Ichimoku cloud cross on 15m (53% but only n=89 — sparse)  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Dashboard Principles
- **Every probability shows sample size (n=X)** — no black boxes
- **Conflicts are surfaced explicitly** — when pressure map and BHG regime disagree, say so
- **Event scenarios are pre-computed** — Kirk sees "if actual = X, expect Y" before the number drops
- **Static lookups, not live predictions** — the backtested stats database gets queried in real-time, but nothing "thinks"


---

## PART 4: TRADINGVIEW INTEGRATION

### Indicator Settings Cheat Sheet
The backtesting engine outputs a definitive reference for Kirk's TradingView layout:
- Which indicators to load on which timeframe chart
- Exact settings per indicator (period lengths, thresholds, band widths)
- What signals to look for and what to ignore
- When each signal works (time-of-day, session, regime) and when it doesn't

This is NOT a static opinion piece — it's derived from the Layer 1 backtesting results. If RSI(14) on 15m only works during RTH morning session with ADX>25, that's what the cheat sheet says.

### Rabid Raccoon TradingView Indicator (Future)
A custom Pine Script indicator that surfaces the system's key signals directly on MES charts:
- **Pressure Map overlay** — colored bar or background showing current cross-market state (risk-on/risk-off/neutral) based on live NQ/YM/RTY/ZN/GC alignment
- **Event proximity markers** — visual countdown to next high-impact release, with scenario map tooltip
- **Backtested signal flags** — when a high-confidence indicator confluence fires (e.g., VWAP + 2SD touch during risk-off with VIX elevated), mark it on the chart with the historical win rate
- **BHG regime label** — current BHG win rate and directional bias in a corner table

This lives in the `indicators/` directory and would be published on TradingView as a private or invite-only indicator.

### TradingView ↔ Dashboard Workflow
1. **Pre-session (5-7 AM):** Check Command Center dashboard for session bias, event timeline, pressure map state, scenario maps
2. **During session:** TradingView charts with backtested indicator settings + RR Indicator overlay for real-time signals
3. **At BHG trigger:** Cross-reference TradingView signal with dashboard's current backtested probability. If high-confidence (>60%, n>200), take the trade. If mixed (<55%), skip or size down.

---

## PART 5: ACCURACY STANDARD — 80% MINIMUM TO TRADE

**Kirk's rule: We do not trade anything under 80% backtested accuracy.**

This is the system's design constraint. It changes everything about how we filter signals:

- **Individual indicators alone:** 52-58% directional accuracy. Not tradeable. These are building blocks, not signals.
- **Two-factor confluence:** 58-65%. Still not tradeable. Getting closer.
- **Three+ factor confluence (pressure map + indicator + event + time-of-day + regime):** This is where 80%+ conditions live. They're narrow and they're rare — maybe 2-5 high-conviction setups per week instead of 15-20.
- **Below 80%:** The dashboard says "NO TRADE." Most of the time, the system will say nothing. This is a FEATURE, not a bug.

**The tradeoff is accuracy vs. frequency.** 80% win rate with extreme selectivity beats 55% win rate on every candle. Kirk doesn't need 20 trades a day — he needs 2-3 trades a week that work.

**Sample size integrity:** An 80% win rate only counts if the sample size backs it up. Minimums:
- n ≥ 100: Reportable. Dashboard shows the stat.
- n ≥ 200: Confident. Dashboard highlights it.
- n < 50: Not shown. Insufficient data, no matter how good the percentage looks.

**The backtesting engine tests everything, including low-accuracy conditions.** But the dashboard only surfaces conditions that cross the 80% threshold with adequate sample sizes. Everything else is suppressed.

---

## PART 6: IMPLEMENTATION PHASES

### Phase 1: ML Model Validation ← IN PROGRESS
- [x] Dataset built (36,040 rows × 144 columns)
- [x] Classification mode configured
- [x] Walk-forward validation implemented
- [x] Bug fixes (dropna, redundant features)
- [x] Phase 1 training launched
- [ ] Evaluate OOF results
- [ ] Feature importance analysis
- [ ] Phase 2 production training (if Phase 1 shows signal)

### Phase 2: Indicator Backtesting Engine (Week 1-2)
- [ ] Build `scripts/backtest-indicators.py`
- [ ] Load all MES 15m and 1h OHLCV from Databento
- [ ] Compute Tier 1 + Tier 2 indicators via pandas-ta
- [ ] For each signal: forward returns at 1/4/16/64 bar horizons
- [ ] Store results in JSON/SQLite: indicator, setting, timeframe, signal_type, occurrences, win_rate, avg_return, MAE, MFE, best_time_of_day
- [ ] Runtime: ~4-8 hours batch compute on 8GB Mac

### Phase 3: Pressure Map Backtesting (Week 2-3)
- [ ] Load NQ, YM, RTY, ZN, GC, VIX, DXY hourly data
- [ ] Define state variables, compute state at each hourly bar
- [ ] MES forward returns conditional on each state
- [ ] Hierarchical filtering until n < 100
- [ ] Output: state → probability lookup table

### Phase 4: Event Backtesting (Week 2-3)
- [ ] Subscribe to Trading Economics ($49/mo)
- [ ] Backfill macro_report_1d with 5 years of actual/forecast/surprise + release timestamps
- [ ] For each event type: MES behavior in -4h to +4h windows
- [ ] Segment by surprise direction and magnitude
- [ ] Cross with pressure map state at event time

### Phase 5: Dashboard Build (Week 3-4)
- [ ] Single-page React dashboard on Vercel (replace current two-page layout)
- [ ] Real-time: current MES price, indicator values, pressure map state, event schedule
- [ ] Static: backtested statistics from Phases 2-4
- [ ] Layout: session bias, pressure map, event timeline, indicator signals, BHG regime, cheat sheet

### Phase 6: TradingView Indicator (Week 4+)
- [ ] Pine Script v6 indicator
- [ ] Pressure map overlay
- [ ] Event proximity markers
- [ ] Backtested signal flags
- [ ] Publish as private/invite-only

### ~~Phase 7: 15-Minute Dual-Timeframe Model~~ DROPPED
**DROPPED (Kirk, 2026-02-27):** 15m model/horizon removed from training scope. Final horizons are 1h, 4h, 1d, 1w — all built from 1h-anchored features. MES 15m data remains for chart display only.

---

## PART 7: DATA INFRASTRUCTURE STATUS

### What Already Exists
| Data | Status | Source |
|------|--------|--------|
| MES OHLCV 1h + 15m | ✅ 2020-present | Databento ($179/mo) |
| 18 cross-asset futures (ES, NQ, YM, RTY, ZN, CL, GC, etc.) | ✅ Backfilled | Databento |
| 47 FRED series (rates, yields, vol, credit, FX, labor, activity) | ✅ Daily ingestion | FRED API (free) |
| Economic calendar | ✅ 3,200 rows, partial actual/forecast/surprise | econ_calendar table |
| Macro reports | ✅ Has reportCode, actual, forecast, surprise | macro_report_1d table |
| News signals | ✅ Headlines + layer/category | news_signals table |
| BHG setups | ✅ Full outcome tracking (TP1/TP2/SL, MAE/MFE) | bhg_setups table |
| Fed RSS/alt-news pipeline | ✅ Exists | ingest-alt-news-feeds.ts |

### What Still Needs Backfill
| Data | Gap | Solution | Cost |
|------|-----|----------|------|
| 5-year economic surprise data (actual vs forecast) | Partial coverage | Trading Economics Calendar API | $49/mo |
| Release timestamps (exact time, not just date) | Missing for many events | Trading Economics | included |
| Rich news content (summaries, not just headlines) | Only titles in news_signals | EODHD or Finnhub | $0-30/mo |
| Fed statements full text | Pipeline exists, needs backfill | federalreserve.gov scrape | Free |

### Monthly Infrastructure Cost
| Item | Cost |
|------|------|
| Databento Standard (existing) | $179 |
| Trading Economics Standard (needed) | $49 |
| EODHD All-In-One (optional) | $30 |
| **Total** | **$228-258** |

---

## PART 8: KEY FILES & SCRIPTS

| File | Purpose |
|------|---------|
| `scripts/train-core-forecaster.py` | ML model training (classification, walk-forward) |
| `scripts/build-complete-dataset.ts` | 1h dataset builder (144 columns) |
| ~~`scripts/build-15m-dataset.ts`~~ | ~~15m dataset builder~~ DROPPED (2026-02-27) |
| `scripts/backtest-indicators.py` | TO BUILD: Indicator backtesting engine |
| `scripts/backtest-pressure-map.py` | TO BUILD: Cross-market state backtesting |
| `scripts/backtest-events.py` | TO BUILD: Event reaction backtesting |
| `datasets/autogluon/core_oof_*.csv` | OOF predictions from model training |
| `models/core_forecaster/` | Saved model artifacts per horizon/fold |
| `indicators/` | TradingView Pine Script indicators |
| `docs/PROJECT-ROADMAP.md` | This document |

---

*This roadmap reflects decisions made across four working sessions on Feb 20, 2026. The central insight: the ML model is ONE input signal among many. The real value is in the statistical backtesting engine that turns every indicator, market state, and event reaction into a verifiable, historically-grounded probability with a sample size. No black boxes.*
