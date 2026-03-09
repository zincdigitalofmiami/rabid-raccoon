# Trigger News, Regime, and Confirmation Spec

**Date:** 2026-03-09
**Status:** Approved baseline for trigger design
**Scope:** MES intraday trigger engine and Core Warbird model foundation
**Implementation contract:** [2026-03-09-trigger-core-contract.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-core-contract.md)

---

## Purpose

This document freezes the core thinking behind the trigger system's use of:

- news
- regime
- correlations
- volume and liquidity
- price-action confirmation

It exists for two reasons:

1. The trigger engine needs a compact, reality-based spec instead of accumulated indicator sprawl.
2. Any future AI used in scripts or runtime must be grounded in these market truths before it is allowed to interpret anything.

This is an intraday MES document. The same regime logic also applies to longer-horizon systems such as the ZL V15 project, but the timing and trigger requirements here are intraday-first.

---

## Core Truths

### 1. The S&P trades surprises, not headlines

The market does not react to the existence of a report by itself. It reacts to the gap between:

- what was expected
- what was released
- what that changes about growth, inflation, yields, and risk premium

This is why the same "good" number can be bullish in one regime and bearish in another.

### 2. Regime controls interpretation

The same news item can mean different things depending on what the market cares about most right now:

- inflation regime
- growth scare regime
- Fed-path regime
- policy shock regime
- geopolitical risk regime

Static assumptions such as "MES always trades with yields" or "dollar always matters the same way" are invalid. Correlation and causality drift.

### 3. News can temporarily override normal trigger rules

On true news-shock bars:

- normal price-action patterns degrade
- correlations can break or invert
- volume and liquidity matter more
- break/retest logic is less reliable

The trigger engine therefore needs explicit news-state handling, not just a generic news flag.

### 4. Hook-and-Go is a validator, not the base trigger

Hook-and-Go is a real and profitable pattern, but for the current phase it should be treated as:

- a validation pattern after a break
- a reusable confirmation layer for later
- not the foundation of the active trigger engine

In fast markets, price often never gives a clean retest. That is why volume and correlations must carry equal confirmation weight alongside price action.

### 5. Too many signals create noise and kill trades

The target is not maximum indicator count. The target is a compact, high-signal framework built from:

- clean market states
- a small adaptive correlation set
- strong volume/liquidity confirmation
- explicit acceptance/failure logic

Signal sprawl produces fewer trades, more hesitation, and erratic outputs.

---

## What News Matters Most To MES / S&P Intraday

### Tier 1: News that can invalidate normal intraday rules

- Employment Situation / Nonfarm Payrolls
- CPI
- FOMC statement and Chair press conference

These releases can reprice the full path of rates, growth, and risk appetite in minutes.

### Tier 2: News that often changes intraday bias materially

- PPI
- PCE / Core PCE
- Retail Sales
- GDP
- ISM Manufacturing
- ISM Services

These releases often change the market's growth/inflation narrative enough to alter directional bias, sector leadership, and correlation behavior.

### Tier 3: News that matters, but usually in a more conditional way

- Initial Claims
- Durable Goods
- JOLTS
- Consumer Confidence / Sentiment
- Treasury refunding / auction headlines

These may still move MES hard if they arrive in a sensitive regime.

### Unscheduled news that can override everything

- Fed speaker surprise guidance
- tariff / trade-policy headlines
- war / sanctions / geopolitical escalation
- banking stress / liquidity stress
- fiscal / legislative shock
- major mega-cap earnings or guidance

Because the S&P 500 is float-adjusted and concentrated in the largest names, mega-cap earnings are index news, not just stock news.

---

## How News Affects MES / S&P

### Channel 1: Rates

Inflation and labor data reprice:

- expected Fed path
- front-end yields
- discount rate applied to equities

In hawkish regimes, "good growth" can be bearish because it lifts yields.

### Channel 2: Growth

Growth-sensitive releases affect:

- forward earnings expectations
- cyclicals vs defensives
- breadth and leadership

In recession or slowdown regimes, bad growth news can hit equities directly.

### Channel 3: Risk premium

Policy and geopolitical news often move the market through:

- uncertainty
- vol expansion
- de-risking
- cross-asset flight to safety

### Channel 4: Market structure

On high-impact releases, price behavior changes mechanically:

- spreads widen
- liquidity thins
- volume surges
- stop-runs and fakeouts increase

That is why trigger confirmation cannot rely on static chart logic alone.

---

## Trigger-Specific News Spec

### Goal

The trigger engine must know when:

- normal rules are valid
- normal rules are degraded
- normal rules should be vetoed
- post-news behavior has settled enough to trust again

### Required trigger news states

The trigger system should classify each bar or decision point into one of these states:

1. `CLEAR`
   No nearby meaningful event pressure.

2. `APPROACHING`
   High-importance scheduled event is close enough that new triggers should be discounted.

3. `BLACKOUT`
   New entries should be blocked because a Tier 1 or equivalent event is too close or just hit.

4. `SHOCK`
   Immediate post-release or unscheduled headline state where price discovery is chaotic and rules are least reliable.

5. `DIGESTION`
   Initial shock has passed, but the market is still repricing the event.

6. `SETTLED`
   The event is no longer the dominant driver.

### Trigger implications by state

`CLEAR`
- normal trigger evaluation allowed

`APPROACHING`
- confidence reduced
- require stronger confirmation
- avoid marginal setups

`BLACKOUT`
- block new entries

`SHOCK`
- block or sharply penalize new entries
- treat volume/liquidity as more important than retest logic

`DIGESTION`
- allow only strong setups with confirmation
- require alignment across volume, price action, and current correlation regime

`SETTLED`
- return to normal logic, but only after the market has shown stable post-event behavior

---

## Trigger Confirmation Framework

The active trigger engine should evaluate four co-equal confirmation layers.

### 1. Correlation confirmation

Use a small, adaptive set of high-value symbols. Not every symbol matters every day.

Core candidate set:

- NQ
- VX / VIX complex
- DXY / USD proxy
- US10Y / ZN / rates complex
- CL and GC when they are actually driving macro tone

Rules:

- the active set must be regime-aware
- correlation strength must be re-evaluated, not assumed
- stale relationships must not be hard-believed

### 2. Volume and liquidity confirmation

Volume is not "the primary truth" by itself. It is one of the two major confirmation pillars alongside correlations.

The trigger engine should not rely on a single boolean such as `volumeConfirmation`.

It should classify meaningful volume/liquidity states such as:

- thin / absent participation
- normal participation
- directional expansion
- exhaustion / blowoff
- absorption / trapped move

Minimum live inputs should include:

- RVOL
- session RVOL
- price vs VWAP
- VWAP location state
- price vs POC
- value-area state
- POC migration
- pace / acceleration of volume

Future-state inputs may include order-book or microstructure-derived liquidity if available, but the current spec does not require that to begin.

### 3. Price-action acceptance / failure

This is where the live trigger is currently missing important nuance.

Required live concepts:

- acceptance after break
- rejection after break
- sweep of prior high/low
- fakeout / failed breakout
- whipsaw behavior
- bull trap / bear trap logic
- blocker density
- open-space quality
- wick/body context

These concepts already exist in historical dataset logic and must be treated as first-class trigger features in live processing.

### 4. News and regime overlay

News state does not replace the trigger. It controls whether the trigger should be trusted.

Rules:

- Tier 1 macro news can veto otherwise-valid setups
- unscheduled policy/geopolitical shock can override normal confirmation logic
- post-news digestion must be explicitly modeled

---

## Local DB Processing Spec

### Operating assumption

Heavy trigger research, replay, and model processing happen against the local DB.

That means the trigger-news system must be designed so normalized event and news data can land in local Postgres for processing, backtests, and later model work.

### Approved architectural intent

- Inngest may remain the orchestration layer for fetch cadence and production-side normalization.
- Local Postgres remains the processing source for heavy trigger analysis.
- If Inngest cannot reliably deliver this data to local DB, a local scheduled consumer may mirror or fetch the same normalized payloads.

The important point is not which scheduler wins. The important point is that trigger processing reads canonical normalized rows from local DB.

### Minimum data categories required in local DB

Scheduled macro:

- event name
- scheduled timestamp
- impact tier
- source
- actual
- forecast
- previous
- surprise
- revised values if available

Fed / policy:

- policy source
- headline timestamp
- classification
- hawkish / dovish or risk-on / risk-off interpretation field only if deterministically derived

News:

- publish timestamp
- source
- headline
- normalized category
- market channel
- urgency / breaking flag
- row hash
- knowledge time

### Existing tables already relevant

- `econ_calendar`
- `macro_reports_1d`
- `news_signals`
- `econ_news_1d`
- `policy_news_1d`

If additive schema work is later needed, it should normalize event/news semantics rather than create more ad hoc flags.

### Delivery patterns allowed by this spec

#### Pattern A: Inngest normalizes, local DB mirrors

- source fetch occurs in cloud/runtime orchestration
- normalized rows are mirrored into local DB
- local trigger processing reads local Postgres only

#### Pattern B: Inngest defines the contract, local scheduler fetches

- Inngest remains the reference cadence/contract
- local machine fetches the same sources directly on schedule
- local DB still receives the same canonical shape

This spec allows either pattern. It does not require blind dependence on one platform-specific intake path.

---

## AI Grounding Rules

Any future AI used in scripts, research tooling, or runtime must be grounded in the following truths before it is allowed to interpret market context:

1. News impact is regime-dependent.
2. Surprise matters more than raw headline existence.
3. Tier 1 macro events can invalidate normal intraday rules.
4. Correlations drift and must be treated as adaptive.
5. Volume/liquidity and correlations are co-equal confirmation layers.
6. Hook-and-Go is a later validator, not the current base trigger.
7. Too many signals create noise and lower decision quality.

### AI constraints

AI must not:

- assume static correlations
- overrule deterministic blackout or shock states
- invent causal stories not supported by the event, regime, and cross-asset response
- treat all news as equal

AI may:

- summarize the dominant current driver
- explain why a setup is downgraded or vetoed
- describe whether rates, growth, risk premium, or policy shock is leading the move

AI is explanatory support. It is not the authority over the trigger state machine.

---

## Immediate Trigger Build Implications

The current trigger lane should do the following in order:

1. Freeze the approved trigger family for the current phase.
2. Remove Hook-and-Go/BHG as the assumed base trigger foundation.
3. Define the active correlation set and make it regime-aware.
4. Replace thin volume booleans with meaningful volume/liquidity states.
5. Port live acceptance / failure / trap logic from historical dataset work.
6. Add explicit news-state handling for blackout, shock, and digestion.
7. Keep AI out of authority and inside explanation.

---

## Sources

- [Federal Reserve FEDS 2025: Decoding Equity Market Reactions to Macroeconomic News](https://www.federalreserve.gov/econres/feds/decoding-equity-market-reactions-to-macroeconomic-news.htm)
- [NBER: The Macroeconomic Announcement Premium](https://www.nber.org/papers/w22527)
- [NBER: Decoding FOMC Announcement Effects](https://www.nber.org/papers/w32884)
- [NBER: Time Variation in Asset Price Responses to Macroeconomic Announcements](https://www.nber.org/papers/w19523)
- [NBER: Macroeconomic News and Stock Returns in the United States and Germany](https://www.nber.org/papers/w19711)
- [NBER: Macroeconomic News and Microeconomic News: Complements or Substitutes?](https://www.nber.org/papers/w28931)
- [NBER: Political Uncertainty and Stock Prices](https://www.nber.org/papers/w16128)
- [NBER: The Effect of U.S. Trade Policy on U.S. Equity Markets](https://www.nber.org/papers/w28758)
- [CME: How Rates, FX and Equity Index Futures Trade Around Economic Data](https://www.cmegroup.com/articles/2025/how-rates-fx-and-equities-trade-economic-data-set-releases.html)
- [BLS Release Calendar](https://www.bls.gov/schedule/2026/home.htm)
- [BLS Employment Situation schedule](https://www.bls.gov/ces/publications/news-release-schedule.htm)
- [BLS CPI](https://www.bls.gov/cpi/)
- [BLS PPI schedule](https://www.bls.gov/schedule/news_release/ppi.htm)
- [BEA schedule](https://www.bea.gov/news/schedule/full)
- [Census Retail Sales schedule](https://www.census.gov/retail/release_schedule.html)
- [Census Durable Goods schedule](https://www.census.gov/manufacturing/m3/release_schedule.html)
- [ISM report calendar](https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/)
- [BLS JOLTS](https://www.bls.gov/news.release/jolts.htm)
- [Conference Board Consumer Confidence](https://www.conference-board.org/topics/consumer-confidence)
- [Federal Reserve FOMC communications](https://www.federalreserve.gov/newsevents/pressreleases/monetary20240809a.htm)
- [S&P 500 index facts and methodology](https://www.spglobal.com/spdji/en/indices/equity/sp-500/)
