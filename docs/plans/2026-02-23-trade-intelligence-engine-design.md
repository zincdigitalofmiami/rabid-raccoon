# Trade Intelligence Engine — Design Document

**Date:** 2026-02-23
**Status:** Approved for implementation
**Author:** Kirk + Claude (Approach C — Hybrid Stack)

---

## Vision

One page. Big chart. Three buttons. Every trade backed by fibs, news, backtesting, correlations, VIX, NQ, dollar, Trump policy, measured moves, and AI reasoning — unified into a single confidence score with near-exact entry levels.

**Core principle:** Every threshold, weight, window, and penalty is derived from backtesting against actual MES outcomes. No arbitrary numbers. No guessing.

---

## 1. Single-Page Layout

Kill both existing pages. One page, chart-first.

```
┌─────────────────────────────────────────────────────┐
│  RABID RACCOON           9:42 AM CT  [Session]      │
├─────────────────────────────────────────────────────┤
│  [ Upcoming Trades ]  [ Daily Moves ]  [ Briefing ] │
├─────────────────────────────────────────────────────┤
│                                                     │
│               LIVE MES CHART (hero)                 │
│     fibs, measured moves, trade levels drawn        │
│     upcoming trade entry/stop/target on chart       │
│                                                     │
├─────────────────────────────────────────────────────┤
│  CONTEXT PANEL (toggles by active button)           │
│                                                     │
│  Upcoming Trades: trade cards — entry, stop, TP1,   │
│   TP2, p(TP1), event context, AI rationale          │
│                                                     │
│  Daily Moves: expected range, key levels,           │
│   today's econ calendar with impact ratings         │
│                                                     │
│  Briefing: 3-sentence market + chart analysis       │
│   (regime, correlations, key risk factors)          │
└─────────────────────────────────────────────────────┘
```

**What gets killed:**
- MarketsPage.tsx (entire component)
- MarketsGrid (symbol grid — noise)
- ForecastPanel (verbose AI narrative — replaced by Briefing)
- CorrelationTile, StatusTile (replaced by context in trade cards)
- Separate /mes route (one page only)
- AnalysePanel (3 timeframe gauges — replaced by trade-level detail)

**What survives:**
- LiveMesChart (hero chart, enhanced with trade level overlays)
- Header (simplified — no nav needed with one page)
- Core BHG engine (fibs, measured moves, swing detection)
- Risk engine (entry/stop/target computation)
- Market context engine (regime, correlations, yields)
- SSE streams (live chart updates)

---

## 2. Phase Rename: Touch-Hook-Go → Contact-Confirm-Trigger

| Old Name | New Name | Meaning |
|----------|----------|---------|
| TOUCHED | CONTACT | Price made contact with fib level |
| HOOKED | CONFIRMED | Wick rejection confirmed the level holds |
| GO_FIRED | TRIGGERED | Breakout confirmed — trade entry |
| EXPIRED | EXPIRED | Setup timed out (unchanged) |

Applied everywhere: BHG engine, types, API responses, UI, database enum.

---

## 3. Event Awareness Engine

### Purpose
Make the system aware of the full lifecycle of scheduled economic releases. Every trade decision knows what's coming, what just happened, and how to adjust.

### Architecture

New module: `src/lib/event-awareness.ts`

```typescript
interface EventContext {
  phase: 'CLEAR' | 'APPROACHING' | 'IMMINENT' | 'BLACKOUT' | 'DIGESTING' | 'SETTLED'
  event: { name: string; impact: 'high' | 'medium' | 'low'; time: Date } | null
  minutesToEvent: number | null
  surprise: { zScore: number; direction: 'BEAT' | 'MISS' | 'INLINE' } | null
  confidenceAdjustment: number  // multiplier from backtesting, e.g. 0.72
  label: string                 // human-readable, e.g. "ISM Manufacturing in 32 min"
}
```

### Event Phases

Every phase boundary and confidence adjustment is derived from backtesting:

| Phase | Definition | How Thresholds Are Derived |
|-------|-----------|---------------------------|
| CLEAR | No high/medium event within window | Backtest: BHG setup hit rates with no nearby events = baseline |
| APPROACHING | Event within T₁ minutes | Backtest: find T₁ where BHG TP1 hit rate starts declining vs baseline. Scan 120/90/60/45/30 min windows, pick the inflection point |
| IMMINENT | Event within T₂ minutes | Backtest: find T₂ where hit rate drops below profitable threshold. This is the "stop taking new trades" point |
| BLACKOUT | T₃ before → T₄ after release | Backtest: find the window where setups that TRIGGER have statistically worse outcomes than random. Hard no-trade zone |
| DIGESTING | T₄ → T₅ after release | Backtest: post-release setups may be valid but need surprise-adjusted confidence. Find T₅ where outcomes normalize to baseline |
| SETTLED | Beyond T₅ | Same as CLEAR — normal trading resumes |

**T₁, T₂, T₃, T₄, T₅ are all backtested parameters**, not hardcoded. They may differ by event type (CPI vs. Jobless Claims) and impact rating.

### Confidence Adjustment

For each phase, backtest the TP1 hit rate of BHG setups that triggered within that phase vs. the baseline (CLEAR phase) hit rate:

```
confidenceAdjustment = hitRate_inPhase / hitRate_baseline
```

Example (hypothetical — real values from backtesting):
- CLEAR: 1.00 (baseline)
- APPROACHING(CPI): 0.68 (setups near CPI hit TP1 32% less often)
- BLACKOUT: 0.00 (no trades)
- DIGESTING(beat > 2σ): 1.15 (strong surprise = momentum, better than baseline)
- DIGESTING(miss > 2σ): 0.55 (big miss = chaos, much worse)

### Surprise Scoring

The `econ_calendar.forecast` field is currently never populated. Two fixes needed:

**Option A — Enrich econ_calendar ingestion:** Add forecast data from FRED or a supplementary source (Trading Economics API, BLS releases). Surprise = `(actual - forecast) / historical_std`.

**Option B — Month-over-month z-score (already built):** The `build-lean-dataset.ts` already computes `cpi_release_z`, `nfp_release_z` etc. as `(actual - previous_actual) / rolling_3yr_std`. This is a change-based surprise, not a forecast-based surprise, but it's available today.

**Recommendation:** Start with Option B (already built, wire it live). Upgrade to Option A when forecast data is available.

---

## 4. Unified Trade Score — The Intelligence Layer

### Architecture: Two Layers

```
Layer 1: Deterministic + ML Baseline (fast, always-on)
├── BHG Engine → fib levels, measured moves, entry/stop/target
├── Risk Engine → R:R ratio, dollar risk, contracts
├── Event Awareness → phase, confidence adjustment, surprise
├── Correlation Filter → VIX/NQ/DXY alignment composite
├── Market Context → regime (risk-on/off), yields, theme scores
└── ML Baseline → p(TP1), p(TP2) from retrained fib-scorer model
    ↓
    Composite Score = weighted combination (weights from backtesting)
    ↓
Layer 2: AI Reasoning (on-demand, for qualifying setups)
├── Receives: full context packet from Layer 1
├── Returns: adjusted confidence, rationale, risk factors
└── Deterministic math retains veto power
```

### Layer 1: Feature Vector (Live)

Port the feature computation from `build-lean-dataset.ts` and `build-bhg-dataset.ts` into a live module: `src/lib/trade-features.ts`

For each TRIGGERED setup, compute in real-time:

**From BHG Engine (existing):**
- fibRatio (0.5 or 0.618)
- goType (BREAK vs CLOSE)
- hookQuality (wick ratio)
- measuredMoveAligned (boolean + quality score)
- stopDistancePts, rrRatio, grade

**From Event Awareness (new):**
- eventPhase (CLEAR/APPROACHING/IMMINENT/BLACKOUT/DIGESTING/SETTLED)
- minutesToEvent
- surpriseZScore (if post-release)
- confidenceAdjustment

**From Market Context (existing, needs real-time wiring):**
- vixLevel, vixPercentile20d, vix1dChange
- regime (RISK_ON / RISK_OFF / MIXED)
- yieldCurveSlope, realRate10y
- themeScores (tariffs, rates, trump, eventRisk)

**From Correlation Filter (existing):**
- vixAlignment, nqAlignment, dxyAlignment
- compositeAlignment, isAligned

**From Technical Indicators (existing in dataset builder, needs live port):**
- sqzMom, sqzState (Squeeze Pro)
- wvfValue, wvfPercentile (Williams Vix Fix)
- macdHist, macdHistColor (CM Ultimate MACD)
- mesEdss, mesRange, mesBodyRatio
- mesRet1h, mesRet4h (recent returns)

**New — From News Signals (currently orphaned):**
- policyNewsVolume24h (count of trump_policy layer articles)
- volatilityNewsVolume24h (count of volatility layer articles)
- econReportVolume24h (count of econ_report layer articles)
- headlinesSummary (top 5 headlines for AI context)

### Composite Score Formula

```
compositeScore = (
    w_fib   * fibScore +          // BHG quality: hookQuality, goType, measuredMove
    w_risk  * riskScore +         // R:R ratio normalized
    w_event * eventScore +        // event awareness confidence adjustment
    w_corr  * correlationScore +  // cross-asset alignment
    w_regime * regimeScore +      // VIX/yield/macro environment
    w_tech  * technicalScore +    // squeeze, WVF, MACD momentum
    w_ml    * mlBaselineScore     // p(TP1) from retrained model
)
```

**ALL weights (w_fib, w_risk, w_event, w_corr, w_regime, w_tech, w_ml) are derived from backtesting.** Specifically:
1. Build the full feature matrix from historical BHG setups
2. Label each setup with actual TP1/TP2 outcome (already in bhg_setups table)
3. Train a meta-model (or use Spearman IC analysis) to determine which features predict outcomes
4. Feature importance = weight in the composite score

### Layer 2: AI Reasoning

Only called for setups where `compositeScore >= threshold` (threshold from backtesting — the point where setups become profitable on average).

**Prompt structure:**

```
You are a futures trade analyst. Given this MES setup and market context,
provide a brief rationale and adjusted confidence.

SETUP:
- Direction: BULLISH
- Entry: 5420.25 (0.618 fib retracement)
- Stop: 5412.50 (below 0.786 level)
- TP1: 5438.75 (1.236 extension) — ML baseline p(TP1): 64%
- TP2: 5452.00 (1.618 extension) — ML baseline p(TP2): 41%
- R:R: 2.4:1 (Grade B)
- Measured move: ALIGNED, quality 78/100

EVENT CONTEXT:
- Phase: DIGESTING (ISM Manufacturing released 12 min ago)
- Surprise: +1.8σ beat (actual 52.1 vs previous 49.8)
- Historical: setups in DIGESTING phase after >1σ beat hit TP1 at 71% (vs 58% baseline)

MARKET CONTEXT:
- Regime: RISK-ON
- VIX: 16.2 (38th percentile, declining)
- NQ: confirming (+0.4% aligned)
- DXY: neutral (flat)
- Yields: 10Y at 4.12%, curve steepening
- Theme: tariff noise low, no FOMC for 18 days

TECHNICAL:
- Squeeze Pro: momentum positive, bars in squeeze: 0
- WVF: 12th percentile (low fear)
- MACD: histogram green, rising

Respond with JSON:
{
  "adjustedPTp1": 0.68,
  "adjustedPTp2": 0.44,
  "rationale": "Bullish 0.618 retracement with ISM beat supporting momentum...",
  "keyRisks": ["VIX could spike on tariff headline", "..."],
  "tradeQuality": "A"
}
```

**Guardrails (same pattern as existing forecast.ts):**
- AI-adjusted p(TP1) must be within ±20% of ML baseline (prevents hallucination)
- If AI is unavailable, Layer 1 composite score stands alone
- Deterministic veto: VIX > 30 forces SELL, never override. Event BLACKOUT = no trades.

---

## 5. Training Model Redesign

### What Changes

The fib-scorer model (`train-fib-scorer.py`) currently trains on features from `build-bhg-dataset.ts` which does NOT include:
- Event proximity features (hours_to_next_high_impact, is_high_impact_day)
- Economic surprise z-scores
- Squeeze/WVF/MACD momentum indicators
- Cross-asset correlation features
- News volume features

### New Training Pipeline

**Step 1: Enrich `build-bhg-dataset.ts`** with the event and technical features already computed by `build-lean-dataset.ts`:

New feature groups to add to BHG dataset:
```
// Event features (from econ_calendar)
hours_to_next_high_impact    // continuous, minutes preferred
event_phase                  // categorical: CLEAR/APPROACHING/IMMINENT/DIGESTING
is_high_impact_day           // binary
surprise_z_last_release      // most recent macro surprise z-score

// Economic surprise z-scores (6 series)
nfp_release_z, cpi_release_z, ppi_release_z,
retail_sales_release_z, gdp_release_z, claims_release_z
econ_surprise_index          // weighted composite

// Technical momentum (port from build-lean-dataset)
sqz_mom, sqz_state, sqz_bars_in_squeeze
wvf_value, wvf_percentile
macd_hist, macd_hist_color, macd_hist_rising

// Cross-asset (from correlation filter + market context)
nq_ret_1h, nq_ret_4h
zn_ret_1h, zn_ret_4h
vix_percentile_20d, vix_1d_change
mes_nq_corr_21d, mes_zn_corr_21d
concordance_1h
equity_bond_diverge
regime_score                 // numeric RISK_ON=1, MIXED=0, RISK_OFF=-1

// News (from news_signals)
news_total_volume_24h
policy_news_volume_24h
volatility_news_volume_24h
```

**Step 2: New labels** (in addition to existing tp1_before_sl_4h, tp2_before_sl_8h):

```
// Finer-grained outcome tracking
tp1_before_sl_1h            // already exists
tp1_before_sl_2h            // NEW — 8 bars
max_favorable_4h            // NEW — max favorable excursion in 4h (for calibration)
max_adverse_4h              // NEW — max adverse excursion (for stop optimization)
time_to_tp1_bars            // NEW — how many bars until TP1 hit (if hit)
```

**Step 3: Retrain fib-scorer** with enriched dataset. The model now learns:
- "Setups near high-impact events have different outcomes"
- "Setups with squeeze momentum aligned hit TP1 more often"
- "Setups when VIX is elevated need wider stops"
- "Policy news volume correlates with volatility regime"

**Step 4: Backtest the event phase thresholds.** After training, use the OOF predictions to:
1. Bucket setups by `hours_to_next_high_impact` (0-15, 15-30, 30-60, 60-120, 120+)
2. Compare TP1 hit rates per bucket
3. Find the inflection points → these become T₁, T₂, T₃, T₄, T₅

**Step 5: Backtest composite weights.** Use the OOF feature importances from AutoGluon to set the `w_*` weights in the composite score formula.

**Step 6: Export for live inference.** Either:
- ONNX export from AutoGluon (if supported for the model type)
- Regime lookup table: bucket feature space into ~50-100 regimes, store average p(TP1)/p(TP2) per bucket
- Python sidecar API: FastAPI wrapper around AutoGluon predictor (simplest, most accurate)

### Model Registry Integration

Finally wire up `mes_model_registry`:
- After training, write model metadata (AUC, Brier, features, hyperparams)
- Live inference reads `isActive = true` row to select which model version to use
- Enables A/B testing of model versions

---

## 6. Trade Card — What the User Sees

Each upcoming trade appears as a card below the chart:

```
┌─────────────────────────────────────────────────────┐
│  ▲ BUY MES @ 5420.25                    Score: A   │
│  0.618 retracement · Measured move aligned          │
│                                                     │
│  Entry   5420.25    TP1   5438.75 (64%)             │
│  Stop    5412.50    TP2   5452.00 (41%)             │
│  Risk    $9.75/ct   R:R   2.4:1                     │
│                                                     │
│  ⚡ ISM beat +1.8σ — momentum likely real            │
│  📊 NQ confirming · VIX declining · DXY flat        │
│                                                     │
│  AI: "Strong 0.618 bounce with ISM tailwind.        │
│  Key risk: tariff headline could spike VIX."        │
└─────────────────────────────────────────────────────┘
```

**Every number is earned:**
- Entry/Stop/TP1/TP2 from BHG fib math
- 64% / 41% from retrained ML model
- Score A from composite formula (backtested weights)
- Event context from event awareness engine
- Correlation summary from live market context
- AI rationale from Layer 2 (OpenAI)

---

## 7. Daily Moves Panel

Shows when "Daily Moves" button is active:

- **Expected range:** ATR-based daily range (from backtested ATR multiplier)
- **Key levels:** Today's fib levels, prior day high/low, overnight high/low
- **Econ calendar:** Today's scheduled releases with times, impact, and if released: actual + surprise score
- **Overnight summary:** What happened in Asia/Europe session (from MES overnight candles)

---

## 8. Briefing Panel

Shows when "Briefing" button is active:

- **Market regime:** 1 sentence (e.g., "RISK-ON: equities bid, bonds sold, VIX at 38th percentile")
- **Chart analysis:** 1-2 sentences on MES structure (e.g., "MES testing 0.618 at 5420 with bullish measured move targeting 5452. Squeeze fired 3 bars ago.")
- **Key risk:** 1 sentence (e.g., "FOMC in 3 days. Tariff headlines have been quiet but could resurface.")

Generated by OpenAI with full market context, but constrained to 3-4 sentences max. Deterministic fallback if AI unavailable.

---

## 9. Alert System

Phase 1 (this build): Visual alerts in the UI. When a new setup reaches TRIGGERED, the trade card pulses/highlights. The chart draws the levels immediately.

Phase 2 (future): Push notifications via browser Notification API or webhook to Discord/Telegram when a high-confidence (Score A/B) setup triggers.

---

## 10. Data Fixes Required

Before any of this works, fix these broken connections:

| Issue | Fix |
|-------|-----|
| `econ_calendar.forecast` never populated | Enrich ingestion with forecast data (FRED or Trading Economics) |
| `econ_calendar.eventTime` timezone bug | "08:30 ET" parsed as UTC in build-lean-dataset.ts — fix to parse as America/New_York |
| `news_signals` orphaned from live system | Wire into trade features: volume counts + headline text for AI |
| `bhg_setups.pTp1/pTp2` always null | Populated by retrained model inference |
| `bhg_setups.correlationScore` always null | Populated from correlation filter at TRIGGERED time |
| `bhg_setups.maxFavorable/maxAdverse` always null | Populated by enhanced lookForwardLabel in build-bhg-dataset |
| `mes_model_registry` never used | Wire into training pipeline output + live inference model selection |
| Databento 30-min delay | Acknowledged limitation — display "data delayed ~30 min" when relevant |

---

## 11. Implementation Order

Accuracy first, UI second. Build the intelligence layer, verify it works, then build the UI to display it.

1. **Event Awareness Engine** — `event-awareness.ts`, reads econ_calendar live
2. **Enrich BHG Dataset** — add event + technical + cross-asset features to `build-bhg-dataset.ts`
3. **Backtest Event Thresholds** — derive T₁-T₅ phase boundaries from historical outcomes
4. **Retrain Fib Scorer** — with enriched features, validate improved AUC/Brier
5. **Live Feature Vector** — `trade-features.ts`, port dataset computation to real-time
6. **ML Inference Path** — connect trained model to live API (ONNX, lookup table, or sidecar)
7. **Composite Score** — weighted formula with backtested weights
8. **AI Reasoning Prompt** — per-trade rationale for qualifying setups
9. **Unified Trade API** — new `/api/trades/upcoming` endpoint returning scored trade cards
10. **Single-Page UI** — chart + 3 buttons + context panels
11. **Chart Overlays** — draw trade levels on LiveMesChart
12. **Daily Moves + Briefing** — panels powered by existing market context + econ calendar
13. **Wire Model Registry** — training writes metadata, live reads active model
14. **Fix Data Issues** — econ_calendar forecast, timezone bug, news wiring

---

## 12. What This Does NOT Include (YAGNI)

- Real-time WebSocket data feed (Databento historical API is the current source — live feed is a separate project)
- Mobile app / push notifications (Phase 2)
- Multi-instrument trading (MES only for now)
- Options/Greeks integration
- Social sentiment (Twitter/Reddit) — not reliable enough
- Automated trade execution — this is decision support, not a bot
