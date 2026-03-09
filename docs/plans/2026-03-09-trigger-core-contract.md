# Trigger Core Contract

**Date:** 2026-03-09
**Status:** Implementation-facing contract
**Depends on:** [2026-03-09-trigger-news-regime-spec.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-news-regime-spec.md)
**Scope:** Current-phase MES intraday trigger engine only

---

## Purpose

This document turns the trigger/news/regime research into an implementation contract.

It freezes:

- what the trigger engine is allowed to depend on
- which confirmation layers are required
- which local DB tables provide those inputs
- which states the runtime must produce
- how vetoes and confidence reductions should be applied

This document is intentionally narrower than a full product design. It is for engineering implementation.

---

## Current-Phase Non-Goals

These are explicitly out of scope for the current trigger pass:

- using Break-Hook-Go / Hook-and-Go as the base trigger family
- giving AI authority over trigger validity
- broad Inngest platform refactors
- full order-book or Level 2 integration
- giant indicator expansion
- static "forever true" cross-asset assumptions

Hook-and-Go remains valid, but it is a later validator layer for Phase 3.

---

## Current Live Mismatch Inventory

This is the gap between the current runtime and the approved direction.

### 1. Wrong setup foundation

Live trigger flow in [compute-signal.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/inngest/functions/compute-signal.ts) still assumes [advanceBhgSetups()](/Volumes/Satechi%20Hub/rabid-raccoon/src/lib/bhg-engine.ts) is the active setup generator.

That is not the approved current-phase trigger foundation.

### 2. Correlation role exists, but trigger wiring is too broad

The registry already has `CORRELATION_SET`, but live trigger loading still uses the broader `ANALYSIS_DEFAULT` role instead of a trigger-specific role.

### 3. Volume contract is too thin

Live runtime volume is effectively:

- RVOL
- session RVOL
- VWAP state
- POC state
- one boolean `volumeConfirmation`

That is not enough for the intended trigger confirmation layer.

### 4. Price-action acceptance logic is missing from live features

Historical dataset work already contains:

- `sweep_flag`
- `acceptance_flag`
- `hook_wick_ratio`
- `hook_body_ratio`
- `nearest_blocker_ticks`
- `open_space_ratio`

But the live trigger feature vector does not expose equivalent first-class trigger fields.

### 5. Event state model is still placeholder-grade

Live [event-awareness.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/lib/event-awareness.ts) still uses placeholder windows and a state set that does not yet include the explicit `SHOCK` state required by the research spec.

---

## Trigger Architecture

The current trigger engine must be organized into five layers.

1. `base trigger candidate`
2. `news/regime gate`
3. `correlation confirmation`
4. `volume/liquidity confirmation`
5. `price-action acceptance/failure confirmation`

The trigger decision comes from the combined result of those layers.

---

## Trigger Contract Types

```ts
type TriggerDirection = 'LONG' | 'SHORT'

type TriggerNewsState =
  | 'CLEAR'
  | 'APPROACHING'
  | 'BLACKOUT'
  | 'SHOCK'
  | 'DIGESTION'
  | 'SETTLED'

type TriggerCorrelationState =
  | 'ALIGNED'
  | 'MIXED'
  | 'DISLOCATED'
  | 'REGIME_UNCERTAIN'

type TriggerVolumeState =
  | 'THIN'
  | 'BALANCED'
  | 'EXPANSION'
  | 'EXHAUSTION'
  | 'ABSORPTION'

type TriggerAcceptanceState =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'FAILED_BREAK'
  | 'TRAP_RISK'
  | 'WHIPSAW_RISK'
  | 'UNRESOLVED'

type TriggerDecision =
  | 'BLOCK'
  | 'DEFER'
  | 'ALLOW'
  | 'PRIORITIZE'

interface BaseTriggerCandidate {
  id: string
  direction: TriggerDirection
  detectedAt: Date
  entryZoneLow: number
  entryZoneHigh: number
  invalidationLevel: number
  target1: number | null
  target2: number | null
  structureReference: string
  setupType: string
}

interface TriggerNewsContext {
  state: TriggerNewsState
  eventName: string | null
  eventCategory: string | null
  impactTier: 'TIER1' | 'TIER2' | 'TIER3' | null
  scheduledTime: Date | null
  actual: number | null
  forecast: number | null
  previous: number | null
  surprise: number | null
  unscheduledShock: boolean
}

interface TriggerCorrelationContext {
  state: TriggerCorrelationState
  activeSymbols: string[]
  alignedSymbols: string[]
  divergingSymbols: string[]
  ignoredSymbols: string[]
  narrative: string
}

interface TriggerVolumeContext {
  state: TriggerVolumeState
  rvol: number
  rvolSession: number
  priceVsVwap: number
  vwapBand: number
  priceVsPoc: number
  inValueArea: boolean
  pocSlope: number
  paceAcceleration: number | null
  narrative: string
}

interface TriggerPriceActionContext {
  state: TriggerAcceptanceState
  acceptanceScore: number
  sweepFlag: boolean
  bullTrapFlag: boolean
  bearTrapFlag: boolean
  whipsawFlag: boolean
  fakeoutFlag: boolean
  blockerDensity: 'CLEAN' | 'MODERATE' | 'CROWDED'
  openSpaceRatio: number | null
  wickQuality: number | null
  bodyQuality: number | null
  narrative: string
}

interface TriggerEvaluation {
  candidate: BaseTriggerCandidate
  news: TriggerNewsContext
  correlations: TriggerCorrelationContext
  volume: TriggerVolumeContext
  priceAction: TriggerPriceActionContext
  decision: TriggerDecision
  vetoReasons: string[]
  downgradeReasons: string[]
}
```

This is the current-phase contract shape. AI may explain it later, but AI does not define it.

---

## News / Regime Contract

### Required states

The runtime must produce:

- `CLEAR`
- `APPROACHING`
- `BLACKOUT`
- `SHOCK`
- `DIGESTION`
- `SETTLED`

### State semantics

`CLEAR`
- no nearby meaningful scheduled pressure

`APPROACHING`
- material scheduled event is near enough that weak setups should not be taken

`BLACKOUT`
- new entries are blocked

`SHOCK`
- immediate post-release or unscheduled-news chaos
- normal pattern reliability is degraded the most here

`DIGESTION`
- repricing is still active
- only strong, confirmed setups should survive

`SETTLED`
- event impact has normalized enough that normal evaluation can resume

### Event categories required

The local processing layer must be able to identify at minimum:

- labor
- inflation
- Fed / rates
- growth
- consumer
- policy / tariff
- geopolitical / war
- banking / liquidity stress
- mega-cap earnings / guidance

### Trigger decision rules

- `BLACKOUT` always blocks new entries
- `SHOCK` usually blocks new entries unless future replay proves a narrowly-defined exception
- `APPROACHING` and `DIGESTION` reduce confidence and require stronger confirmation

---

## Correlation Contract

### Philosophy

Correlation is a co-equal confirmation layer with volume/liquidity. It is not a decorative dashboard readout.

### Registry requirement

Do not use `ANALYSIS_DEFAULT` as the trigger correlation source.

The live trigger correlation source is `CORRELATION_SET`. Its approved active
membership is now frozen to the Databento Standard-supported basket below.

### Required core symbols

The trigger correlation core should include:

- `MES`
- `NQ`
- `RTY`
- `ZN`
- `CL`
- `6E`

Rationale:

- `NQ` for equity leadership / tech risk tone
- `RTY` for breadth / financing sensitivity
- `ZN` for rates / duration interpretation
- `CL` for inflation shock transmission
- `6E` as the approved CME-path USD proxy

Not approved for the live trigger basket:

- `VX`
- `DX`
- `GC`
- `YM`
- FRED daily-only series

### Correlation output requirement

The trigger engine must output:

- which symbols were considered active
- which aligned with the candidate
- which diverged
- which were ignored as irrelevant in the current regime

That keeps the system adaptive instead of pretending every relationship matters equally every day.

---

## Volume and Liquidity Contract

### Philosophy

Volume is a co-equal confirmation layer with correlations.

It must not remain a single boolean.

### Required public runtime state

The trigger runtime must classify one of:

- `THIN`
- `BALANCED`
- `EXPANSION`
- `EXHAUSTION`
- `ABSORPTION`

### State semantics

`THIN`
- participation too weak to trust the move
- increases fakeout and whipsaw risk

`BALANCED`
- normal participation
- not a positive confirmation by itself

`EXPANSION`
- price move is being supported by meaningful directional participation

`EXHAUSTION`
- very strong participation but diminishing structural quality
- often late move / blowoff risk

`ABSORPTION`
- heavy participation but poor progress
- trap risk is elevated

### Minimum required live inputs

The current live layer must compute and retain:

- `rvol`
- `rvolSession`
- `priceVsVwap`
- `vwapBand`
- `priceVsPoc`
- `inValueArea`
- `pocSlope`
- `paceAcceleration`

### Source of truth

Current source remains MES 1m data in local/direct Postgres:

- `mkt_futures_mes_1m`

Volume logic should remain MES-first for the current phase. Multi-symbol volume intelligence is later work.

---

## Price-Action Confirmation Contract

### Philosophy

This is the part that decides whether structure is being accepted or rejected.

### Required live concepts

The live trigger runtime must expose equivalents for:

- acceptance after break
- rejection after break
- sweep of prior high/low
- fakeout / failed break
- bull trap
- bear trap
- whipsaw risk
- blocker density
- open-space quality
- wick/body quality

### Source material already in repo

Historical logic already exists in:

- [build-bhg-dataset.ts](/Volumes/Satechi%20Hub/rabid-raccoon/scripts/build-bhg-dataset.ts)

Relevant fields already proven useful enough to keep:

- `sweep_flag`
- `acceptance_flag`
- `hook_wick_ratio`
- `hook_body_ratio`
- `nearest_blocker_ticks`
- `open_space_ratio`

Those ideas should be ported into live trigger processing without dragging BHG in as the base setup family.

### Required public runtime state

The trigger runtime must classify one of:

- `ACCEPTED`
- `REJECTED`
- `FAILED_BREAK`
- `TRAP_RISK`
- `WHIPSAW_RISK`
- `UNRESOLVED`

---

## Local DB Data Contract

The trigger engine depends on canonical local DB rows, not on direct ad hoc API calls inside feature logic.

### Scheduled macro inputs

Primary table:

- `econ_calendar`

Fields already present and required:

- `eventDate`
- `eventTime`
- `eventName`
- `eventType`
- `forecast`
- `previous`
- `actual`
- `surprise`
- `impactRating`
- `source`
- `knowledgeTime`

Supporting table:

- `macro_reports_1d`

Useful fields already present:

- `reportCode`
- `reportName`
- `category`
- `releaseTime`
- `actual`
- `forecast`
- `previous`
- `revised`
- `surprise`
- `surprisePct`
- `source`
- `knowledgeTime`

### News inputs

Primary tables:

- `news_signals`
- `econ_news_1d`
- `policy_news_1d`

Important existing fields:

`news_signals`
- `title`
- `link`
- `pubDate`
- `source`
- `query`
- `layer`
- `category`

`econ_news_1d`
- `publishedAt`
- `headline`
- `summary`
- `source`
- `topics`
- `subjects`
- `tags`
- `knowledgeTime`
- `rowHash`

`policy_news_1d`
- `publishedAt`
- `headline`
- `summary`
- `source`
- `region`
- `country`
- `tags`
- `knowledgeTime`
- `rowHash`

### Cross-asset market inputs

Current local DB sources:

- `mkt_futures_mes_1m`
- `mkt_futures_mes_15m`
- `mkt_futures_1d`
- `econ_vol_indices_1d`
- `econ_yields_1d`
- `econ_fx_1d`

### Delivery requirement

For trigger processing, it is acceptable if:

1. Inngest fetches/normalizes and local DB mirrors the canonical result, or
2. local scheduler fetches the same sources directly and writes the same canonical result

The key requirement is stable local DB shape, not attachment to one scheduler.

---

## Veto and Downgrade Order

The trigger engine must evaluate in this order:

1. `news veto`
2. `liquidity / volume failure veto`
3. `price-action failure veto`
4. `correlation downgrade or upgrade`
5. `final prioritization`

### Hard vetoes

Examples of states that should hard-block by default:

- `news.state === BLACKOUT`
- `news.state === SHOCK`
- `priceAction.state === FAILED_BREAK`
- `priceAction.state === TRAP_RISK` when volume is `ABSORPTION` or `THIN`

### Downgrades

Examples of states that should downgrade but not always block:

- `APPROACHING`
- `DIGESTION`
- `MIXED` correlations
- `THIN` volume
- `UNRESOLVED` price action

### Prioritization

A candidate should only be `PRIORITIZE` when:

- news is not vetoing
- correlations are aligned enough for the current regime
- volume is supportive
- price action is accepted rather than unresolved or failing

---

## AI Constraints

AI may summarize:

- what macro driver is dominant
- why a trigger was blocked or downgraded
- why the current regime made a normal setup invalid

AI may not:

- override blackout or shock states
- override deterministic trap/failure states
- invent new confirmation logic outside this contract

---

## Implementation Order

1. Freeze the current-phase base trigger family.
2. Stop using BHG as the assumed base setup generator.
3. Add trigger-owned correlation roles in the registry.
4. Replace the current thin volume boolean contract with enum-like runtime states.
5. Port acceptance / sweep / trap / open-space logic from historical work into live processing.
6. Extend [event-awareness.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/lib/event-awareness.ts) from placeholder windows/state model to the approved trigger news state model.
7. Keep AI explanatory only.

---

## Files Expected To Change When This Contract Is Implemented

- [compute-signal.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/inngest/functions/compute-signal.ts)
- [route.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/app/api/trades/upcoming/route.ts)
- [trade-features.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/lib/trade-features.ts)
- [correlation-filter.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/lib/correlation-filter.ts)
- [event-awareness.ts](/Volumes/Satechi%20Hub/rabid-raccoon/src/lib/event-awareness.ts)
- [compute-volume-features.py](/Volumes/Satechi%20Hub/rabid-raccoon/scripts/compute-volume-features.py)

Possible additive registry/schema work:

- symbol-role migration or seed update for trigger-specific correlation roles
- additive normalized news/event fields only if required after full grep and design review
