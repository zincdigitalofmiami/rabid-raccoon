# Pre-Phase-1 Trigger Governance Approval Package

Date: 2026-03-08
Repo: `/Volumes/Satechi Hub/rabid-raccoon`
Status: Governance package only (no broad implementation started)

## 1. MACD Spec Review

### Canonical recommendation
- `macdLine = EMA(close, 12) - EMA(close, 26)`
- `macdSignal = EMA(macdLine, 9)`
- `macdHist = macdLine - macdSignal`

### Timeframe policy
- `15m`: trigger-critical
- `1h`: confirmation
- `4h`: context-only (initial)
- `1d`: model/context-only (initial)

### Canonical MACD fields
- `macdLine`
- `macdSignal`
- `macdHist`
- `macdAboveSignal`
- `macdAboveZero`
- `macdSignalAboveZero`
- `macdBullCross`
- `macdBearCross`
- `macdHistRising`
- `macdHistColor` (display/state, not primary scoring truth)

### Validation / parity plan
- Use TradingView CSV fixtures for field-level parity (line/signal/hist/cross states).
- Keep one parameter set across timeframes unless out-of-sample evidence forces split.
- Block trigger-critical use if MACD parity drifts from canonical formulas.

## 2. Volume Spec Review

### Canonical runtime contract (approved)
- `rvol`
- `rvolSession`
- `vwap`
- `priceVsVwap`
- `vwapBand`
- `poc`
- `priceVsPoc`
- `inValueArea`
- `volumeConfirmation`
- `pocSlope`

Source of truth:
- HEAD/main committed runtime source:
- [compute-signal.ts](/Volumes/Satechi Hub/rabid-raccoon/src/inngest/functions/compute-signal.ts)
- [compute-volume-features.py](/Volumes/Satechi Hub/rabid-raccoon/scripts/compute-volume-features.py)
- Local candidate only (not committed in HEAD/main):
- [volume-contract.ts](/Volumes/Satechi Hub/rabid-raccoon/src/lib/volume-contract.ts)
- [runtime-volume-features.ts](/Volumes/Satechi Hub/rabid-raccoon/src/lib/runtime-volume-features.ts)
- [volume-feature-contract.md](/Volumes/Satechi Hub/rabid-raccoon/docs/volume-feature-contract.md)

### Runtime path
- Deployed HEAD/main path shells out from [compute-signal.ts](/Volumes/Satechi Hub/rabid-raccoon/src/inngest/functions/compute-signal.ts) to [compute-volume-features.py](/Volumes/Satechi Hub/rabid-raccoon/scripts/compute-volume-features.py) via `python3`.
- Node/TypeScript runtime-volume path via `computeRuntimeVolumeFeatures()` is local-candidate only and is not committed/deployed in HEAD/main.
- Non-RTH stale-price bug fix documented in [runtime-volume-features.ts](/Volumes/Satechi Hub/rabid-raccoon/src/lib/runtime-volume-features.ts) is candidate-only and not HEAD/main committed truth.

### Volume confirmation semantics
- Directional confirmation only:
1. Current 15m block volume > `1.5x` prior 15m block.
2. Current and prior 15m move directions match.
3. Both moves exceed one tick.

### Current parity truth
- Runtime uses 10-field contract.
- Training dataset still uses older 4-feature volume set and different VWAP/session semantics.
- This is an open model/runtime parity blocker, not a cosmetic enhancement.

## 3. Dual Rates Design (US10Y + ZN)

### Non-interchangeability
- `US10Y` (FRED `DGS10`) = macro regime/yield-level context (daily cadence).
- `ZN` (Databento futures) = tradable rates-flow confirmation (intraday + daily).

### Role by layer
- Trigger-critical now: `ZN` flow + `US10Y` context together.
- Model-critical now: both.
- Do not collapse one into the other.

### Verified availability
- `ZN` present in `mkt_futures_1h/1d` with fresh rows through March 5-6, 2026.
- `DGS10` present in `econ_yields_1d` through February 25, 2026.

### Rates vol/stress extension
- Options-derived rates stress can be added later as regime overlay; not required to start deterministic V1 trigger.

## 4. BANK / Financials Acquisition Plan

### Current reality
- No direct BANK futures/index feed currently validated in active runtime tables.
- Symbol registry analysis roles currently include MES/NQ/YM/RTY/VX/US10Y/ZN/DX/GC/CL, but not a live BANK instrument.

### Acceptable interim proxies (non-trigger-critical)
- Credit/financial stress proxies already available:
- `BAMLH0A0HYM2` (HY OAS)
- `BAMLC0A0CM` (IG OAS)
- `NFCI`

### Preferred acquisition order
1. Databento-covered tradable financials proxy (if subscription supports appropriate instrument).
2. If absent, controlled Yahoo fallback for bank ETF proxy.
3. Keep FRED credit stress as baseline regime context either way.

### Phase classification
- BANK direct feed: blocked pending acquisition.
- Until acquired: model-side or regime overlay only, not trigger-critical confirmation truth.
- No placeholder BANK factor in trigger scoring.

## 5. Event-Risk Engine Scope

### Required event set
- CPI
- PPI
- Core PCE
- NFP / payrolls
- jobless claims
- FOMC rate decisions
- Powell / Fed speakers
- ISM
- retail sales
- GDP / revisions
- Treasury auction stress (later)

### Event-state model
- `blackout`
- `approach`
- `imminent`
- `digest`
- `settled`
- surprise direction/magnitude
- historical reaction profile

### Trigger vs model effect
- Trigger: deterministic gating/penalties/blocks around phase and surprise state.
- Model: broader reaction-distribution learning and regime conditioning.

### Current data truth
- `econ_calendar` schema supports required fields (`eventName`, `eventType`, `eventTime`, `forecast`, `previous`, `actual`, `surprise`, `impactRating`).
- Event taxonomy is not yet canonicalized to the required business set (needs mapping layer).
- Some required categories are sparse by name today (e.g., Core PCE/Fed speakers/ISM/Treasury auction patterns).

## 6. News-Flow Engine Architecture

### Governance boundary
- AI can enrich upstream only (classify/dedupe/novelty/urgency/entity/theme).
- Trigger consumes deterministic downstream scores only.
- Trigger does not consume raw AI opinions.

### Target trigger-facing deterministic fields
- `fedShockScore`
- `inflationShockScore`
- `laborShockScore`
- `growthShockScore`
- `geoRiskScore`
- `tariffTradeScore`
- `energyShockScore`
- `bankStressScore`
- `volStressScore`
- `headlineVelocity15m`
- `headlineVelocity60m`
- `breakingFlag`
- `sourceConfidence`
- `reactionScore`

### Deterministic governance contract (finalized)
- Source weighting:
- Tier 1 (`1.00`): official releases/regulators/exchanges (Fed, BLS, BEA, Treasury, FRED releases, exchange notices).
- Tier 2 (`0.85`): top-tier wires (Reuters/AP/Bloomberg-equivalent feeds when available).
- Tier 3 (`0.65`): curated financial press with consistent timestamp/domain quality.
- Tier 4 (`<=0.35`): aggregators/social-style feeds; never trigger-critical alone.
- Dedupe:
- Exact dedupe key: normalized headline + canonical source domain + 30-minute bucket.
- Near-duplicate suppression: same category/entity cluster with high token overlap in a 90-minute window collapses into one event family.
- Freshness windows:
- `breakingFlag`: 15 minutes.
- shock category windows (`fed`, `inflation`, `labor`, `growth`, `geopolitics`, `tariff/trade`, `bank_stress`, `vol_stress`): 60 minutes.
- regime/news velocity context: 24 hours with deterministic decay.
- Novelty:
- Novel if no close-match event in same category/entity cluster inside the prior 6 hours.
- Otherwise marked continuation and down-weighted.
- Deterministic reaction linkage:
- For each accepted headline family, compute post-headline reactions on `MES`, `NQ`, `VIX`, `US10Y`, `ZN` for 5m / 15m / 60m windows.
- Persist directional sign-consistency and normalized magnitude; `reactionScore` is formula-driven from these reactions plus source weight and novelty weight.

### Current repo reality
- Active layers: `trump_policy`, `volatility`, `banking`, `econ_report`.
- Category coverage exists for tariff/vol/banking/credit/geopolitical themes, but uneven for energy.
- Requires deterministic category normalization map before scoring-critical use.

## 7. Vol / Stress Complex Inventory

Classification target labels:
- `trigger now`
- `trigger later`
- `model now`
- `regime overlay only`
- `low priority`

### Inventory (current recommendation)
- `VIX (VIXCLS)`: trigger now (baseline vol regime)
- `VXVCLS`: treat as 3-month VIX term-structure input (not VVIX, not vol-of-vol)
- `VVIX` (true vol-of-vol): trigger later only when true series is sourced and mapped distinctly
- `VXN (VXNCLS)`: model now / trigger later
- `OVX (OVXCLS)`: model now / regime overlay
- `VXD (VXDCLS)`: model now / regime overlay
- `HY OAS (BAMLH0A0HYM2)`: trigger later, model now
- `IG OAS (BAMLC0A0CM)`: trigger later, model now
- `NFCI`: regime overlay now
- `USEPUINDXD`: model now / regime overlay now
- `USEPUINDXM` + monthly EPU family: model now (lag-aware), regime overlay
- `WALCL`: regime overlay now
- `RRPONTSYD`: regime overlay now
- `SOFR`: regime overlay now
- Other uncertainty/liquidity series already ingested: model/regime overlays unless intraday signal value is proven.

### Naming guardrail (explicit)
- `VXVCLS` must be labeled as VIX 3M / term structure.
- Do not label `VXVCLS` as `VVIX`.
- Any future `VVIX` usage requires a separate true vol-of-vol series ID and separate feature namespace.

### CL / GC role classification (explicit)
- `CL`:
- Trigger role: conditional confirmation only (energy-sensitive break/reclaim states), never sole trigger gate.
- Model role: include now as predictive cross-asset input.
- Regime role: include now as inflation/growth stress overlay.
- `GC`:
- Trigger role: conditional confirmation only (risk-off / real-yield conflict states), never sole trigger gate.
- Model role: include now as predictive cross-asset input.
- Regime role: include now as risk/real-rate overlay.

## 8. Sweep / Acceptance Trigger-State Design

### Required state outcomes
- accepted break / continuation
- failed break / reclaim
- liquidity sweep / stop run
- ambiguous no-trade

### Required feature/state inputs
- breach excursion
- closes beyond level
- time spent beyond level
- reclaim latency
- wick-through vs body-close-through
- displacement quality
- break volume burst
- reclaim volume
- VWAP reclaim/rejection
- POC / value-area behavior
- intermarket confirmation at break
- event/news state at break

### Core governance
- Volume is mandatory in sweep detection.
- Price-only breach logic is insufficient.

## 9. Tick vs 1m Phased Design

### V1 (now)
- Build deterministic trigger using `1m` structure + canonical volume + intermarket + event/news state.
- Do not block V1 on tick/order-flow infrastructure.

### V2 (later)
- Add tick/order-flow enrichments (absorption, micro-imbalance, queue effects) only after V1 parity/backtest validation.

## 10. Trigger Training / Backtest Design

### Deterministic engine vs trained model
- Deterministic engine owns state definition and trigger math.
- Trained model calibrates confidence/edge conditional on deterministic state and broader feature surface.

### Label set (required)
- `accepted_break`
- `failed_break`
- `liquidity_sweep_reversal`
- `clean_continuation`
- `ambiguous_no_edge`

### Label construction basics
- Use post-signal path with MAE/MFE and reclaim/continuation thresholds.
- Include time-to-failure/time-to-confirmation constraints.
- Separate event-day slices and volatility-regime slices.

### Validation gates before approval
- Walk-forward by regime and year.
- Event-window stratified results.
- Stop-bucket and confluence-behavior checks.
- TradingView parity checks for indicator/state fields.

## 11. Training Simplicity Rule

Hard rule:
- Warbird/model uses all available data.
- Trigger-engineered feature layer stays compact, canonical, auditable.
- No indicator bloat.
- Intelligence comes from correct state modeling, not redundant variants.

Applied to:
- MACD: one canonical formula set.
- Volume: one canonical 10-field contract.
- Intermarket: curated core basket + explicit overlay layer.
- Event/news: deterministic normalized states, not uncontrolled feature explosion.

## 12. AI Governance

Hard boundary:
- AI is not trigger owner.
- Trigger core remains deterministic.
- Sonnet 4.5 is acceptable if 4.7 is unavailable.

AI may assist:
- news enrichment
- reasoning support
- summarization

AI may not own:
- trigger math
- structure classification truth
- entry/stop/TP logic
- core scoring truth

## 13. Placeholder Removal Inventory

| Feature / Area | Why unacceptable | Replace/remove phase | Severity |
|---|---|---|---|
| `event-awareness` phase windows + confidence constants marked `BACKTEST-TBD` | Hand-tuned placeholders in trigger-adjacent logic | Phase 1/validation cycle | High |
| Surprise `zScoreProxy = (actual-forecast)/abs(forecast)` fallback | Not a true standardized surprise model | Phase 1/2 event engine hardening | High |
| `vixPercentile()` rough buckets in `trade-features.ts` | Approximate percentile mapping, not empirical rolling percentile | Phase 1 cleanup | High |
| `compute-signal` neutral market/alignment fallbacks | Can mask degraded context quality | Phase 1 guardrails + hard-fail policy for critical paths | High |
| Proxy mapping (`VX->VIXCLS`, `US10Y->DGS10`, `DX->DTWEXBGS`) used as if equivalent intraday instruments | Semantic mismatch if untreated | Keep as explicit proxies now; revisit in phase capability expansion | Medium |
| Runtime/training volume mismatch | Shared feature layer not numerically aligned | Must resolve before claiming final shared architecture | High |

## 14. Updated Clear Recommendation

### Can MACD work proceed next?
Yes, with canonical EMA MACD spec and strict parity checks.

### Is volume work ready?
Partially. Runtime path is now structurally coherent, but model/runtime parity is still open and must be closed before claiming final shared feature completion.

### Preconditions before implementation approval
1. Freeze canonical contracts (MACD + volume) in code and docs.
2. Add explicit proxy semantics for non-intraday macro series in trigger context.
3. Add deterministic mapping layer for event/news taxonomy normalization.
4. Resolve high-severity placeholder items in Section 13.
5. Keep heavy feature/training/backtest computation local-first and script-owned.

### Degraded-state contract (finalized)
- `hard-fail trigger execution`:
- Primary MES market data unavailable or invalid (`mkt_futures_mes_1m` + required 15m/derived bar context cannot be built).
- Core trigger math stage throws (swing/fib/measured-move/BHG setup generation cannot complete deterministically).
- `degraded_no_trade` (publish explicit no-trade state, not silent neutral):
- Volume feature engine unavailable or internally inconsistent for current run.
- Event-risk context unavailable during active high-impact window (`approach`/`imminent`/`blackout`/`digest` expected but missing).
- Correlation/alignment core unavailable while trigger attempts directional scoring.
- `context-only degrade` (keep engine running, reduce confidence and mark degraded flags):
- Slow macro overlays stale (EPU/liquidity/credit regime families).
- News enrichment sparse/stale outside immediate shock windows.
- Non-core cross-asset context degraded while MES + core setup math + risk controls remain intact.

### Freshness SLA by feed family (market-open policy)
| Feed family | Freshness target | Hard fail | degraded_no_trade | context-only |
|---|---:|---|---|---|
| MES 1m / 15m core (Databento) | <= 3 minutes in active session | > 10 minutes stale or invalid bars | 5-10 minutes stale | n/a |
| Core cross-asset futures (`NQ`,`ZN`,`CL`,`GC`,`YM`) | <= 90 minutes (1h bars) | n/a | if `NQ` and `ZN` both unavailable in directional run | single-symbol stale |
| FRED daily critical (`VIXCLS`,`DGS10`,`DTWEXBGS`) | <= 2 business days | n/a | all three stale together | one/two stale |
| FRED weekly/monthly overlays (NFCI, WALCL, EPU monthly family) | within release cadence + 1 period | n/a | n/a | stale beyond cadence |
| Event calendar (`econ_calendar`) | refreshed daily before session + intraday event awareness availability | missing table/parse failure | stale or missing during high-impact windows | stale with no nearby events |
| News signals (`news_signals`) | breaking 15m / shock 60m / regime 24h | n/a | missing in active shock windows | stale outside shock windows |
| Options proxy surfaces | <= 1 trading day for model use | n/a | n/a | stale model-only feature group |

### Approval stance
- Pre-Phase-1 governance is sufficiently defined to start tightly scoped implementation work **after** preconditions above are acknowledged and sequenced.
- Do not start broad Phase 2 capability buildout under this approval.

---

## Data Source Availability Matrix

Source priority used:
1. Databento
2. FRED
3. Yahoo fallback
4. Options-derived proxy when justified

| Item | Preferred source | Fallback | Available now | Caveat | Owner | Storage |
|---|---|---|---|---|---|---|
| NQ | Databento | FRED index proxy | Yes | Good intraday/daily coverage | Both | `mkt_futures_1h/1d` |
| US10Y | FRED `DGS10` | options proxy later | Yes | Daily macro proxy only | Both | `econ_yields_1d` |
| ZN | Databento | FRED context | Yes | Intraday + daily present | Both | `mkt_futures_1h/1d` |
| VIX baseline | FRED `VIXCLS` | Yahoo `^VIX` | Yes | Daily close series | Both | `econ_vol_indices_1d` |
| DXY/DX | FRED `DTWEXBGS` | Yahoo ICE DX | Yes | Broad dollar index proxy semantics | Both | `econ_fx_1d` |
| Dow | Databento `YM` + FRED `DJIA` | Yahoo `^DJI` | Yes | Futures + cash index duality | Both | `mkt_futures_*`, `econ_indexes_1d` |
| BANK/financials direct | Databento target | Yahoo bank ETF | No (direct) | Not acquired/live in runtime tables | Model now / trigger later | Not yet designed |
| CL | Databento | FRED WTI | Yes | Trigger=conditional confirm; Model=yes; Regime=yes | Both | `mkt_futures_1h/1d` |
| GC | Databento | FRED/vol proxy | Yes | Trigger=conditional confirm; Model=yes; Regime=yes | Both | `mkt_futures_1h/1d` |
| Vol meters (VIX/VXN/OVX/VXD/VXV) | FRED | Yahoo edge fallback | Yes (partial) | `VXVCLS` is term structure (VIX 3M), not VVIX | Both | `econ_vol_indices_1d` |
| Credit stress (HY/IG OAS) | FRED | none | Yes | Daily cadence | Both | `econ_vol_indices_1d` |
| Liquidity (WALCL/RRP/SOFR) | FRED | none | Yes | Mixed frequency lag handling needed | Both | `econ_money_1d`, `econ_rates_1d` |
| EPU/uncertainty | FRED | none | Yes | Monthly series lag | Both | `econ_vol_indices_1d` |
| Event calendar fields | Econ calendar ingest | none | Yes | Taxonomy normalization required | Both | `econ_calendar` |
| News categories | `news_signals` layers | source expansion later | Partial | Uneven taxonomy coverage (energy weak) | Both | `news_signals` |
| Options proxies | Databento options datasets | none | Partial | OHLCV broad; statistics sparse beyond ES.OPT | Model now / trigger later | `mkt_options_*`, local datasets |

## Local Training Ownership Plan

### Local-only by default
- Dataset builders
- Backtests / walk-forward
- Label generation
- Bulk feature recomputation
- Historical options-derived research tables
- Heavy analytics/training prep

### Never cloud-route by default
- Long-horizon feature joins
- Backtest matrix generation
- Bulk historical recalculations
- Research-table derivations

### Cloud/runtime ownership only when truly runtime-critical
- Live signal computation
- Runtime freshness jobs required for dashboard/API behavior

### Storage policy
- Runtime-critical compact features: existing cloud DB tables.
- Heavy derived training artifacts: local files/parquet or local-only derived DB targets.
- Promotion from local-only to cloud/runtime requires explicit approval.
