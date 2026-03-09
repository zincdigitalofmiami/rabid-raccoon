# Pre-Phase-1 Trigger Governance Handoff

> Historical checkpoint.
> Do not treat the git state or working-tree listings in this file as current repo truth.
> Use it for background and prior reasoning only, then verify everything against current `main`.

Date: 2026-03-07
Repo: `/Volumes/Satechi Hub/rabid-raccoon`
Owner/Architect: Kirk
Role split:
- GPT-5.4 chat = architecture / review / governance
- Codex = executor

## Stop Point

This is the clean breakpoint before Phase 1 trigger-engine implementation.

We are still in governance/spec/hardening work. We are **not** approved to start broad Phase 1 math rebuild yet.

## Current Git State

Branch:
- `main`

Last clean pushed commit:
- `01bef05` `fix(deploy): restore compute-signal companions and register 15m jobs`

Current working tree:
- modified: `scripts/compute-volume-features.py`
- modified: `src/inngest/functions/compute-signal.ts`
- modified: `src/lib/trade-features.ts`
- untracked: `docs/volume-feature-contract.md`
- untracked: `src/lib/runtime-volume-features.ts`
- untracked: `src/lib/volume-contract.ts`

Meaning:
- there is uncommitted volume-contract/runtime work in progress
- it has been locally verified, but **not committed/pushed/deployment-verified yet**

## What Was Already Verified Before This Stop

### Phase 0

Phase 0 was previously completed and cleaned up:
- commit `1f3b109` = Phase 0 DB-load and script-routing work
- later main cleanup / deploy repair landed at `01bef05`
- production was moved back to a clean `main` deployment

### Current volume-runtime refactor in working tree

This in-progress work was reviewed and found directionally correct:
- deployed runtime volume path moved from Python shell-out to Node/TypeScript
- canonical volume contract extracted
- Python volume script retained for local/offline diagnostics only
- docs added for runtime volume contract

Local verification already reported:
- `npx eslint src/lib/volume-contract.ts src/lib/runtime-volume-features.ts src/lib/trade-features.ts src/inngest/functions/compute-signal.ts`
- `npx tsc --noEmit --pretty false`
- `npm run build`
- `python3 -m py_compile scripts/compute-volume-features.py`

Runtime spot-check already reported:
- TS runtime volume computation returned live non-default values from DB

Important:
- this work is **not a clean checkpoint yet** until committed, pushed, and deployment-verified

## Hard Governance Rules In Force

- permanent fixes only
- no bandaids
- trigger core must remain deterministic
- AI must not own trigger math
- Sonnet 4.5 is acceptable if 4.7 is unavailable
- Warbird/model training uses **all available data**
- trigger feature layer stays compact, canonical, auditable
- heavy training/backtest/dataset work must be **local-first and script-owned**
- do not route heavy feature-building/training data work through cloud runtime / deployed Inngest / cloud Prisma paths

## Current Strategic Direction

The trigger should become smart through:
- acceptance vs sweep classification
- correct structural math
- volume behavior at breaks/reclaims
- intermarket confirmation
- event-risk state
- news-shock state
- later training/backtest calibration

The trigger should **not** become smart through:
- AI deciding entries
- bloated indicator variants
- placeholder math
- silent neutral fallbacks masking bad data

## Approved MACD Direction

Canonical MACD spec:
- `macdLine = EMA(close, 12) - EMA(close, 26)`
- `macdSignal = EMA(macdLine, 9)`
- `macdHist = macdLine - macdSignal`

Approved live/shared MACD fields:
- `macdAboveZero`
- `macdAboveSignal`
- `macdHistAboveZero`

Timeframe ownership:
- `15m` = trigger-critical
- `1h` = confirmation
- `4h` = context-only initially
- `1d` = model/context-only initially

Current repo mismatch still to be corrected later:
- runtime and dataset MACD still use SMA signal in current committed code

## Approved Volume Direction

Canonical shared volume contract:
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

Runtime architecture:
- deployed runtime should use Node/TypeScript volume computation
- Python volume script is local/offline/diagnostic only

Governance:
- no silent neutralization in trigger-critical paths
- runtime/training parity is mandatory before claiming shared feature-layer completion

Known parity gap:
- runtime uses canonical 10-field layer
- training dataset still uses older 4-feature volume set and different session anchoring

## Intermarket / Macro / Event / News Direction

### Dual rates

Use both:
- `US10Y` for macro / regime / yield-level context
- `ZN` for tradable intraday rates-flow confirmation

Do not collapse them into one proxy.

### Core confirmation basket direction

Always-on / high-priority:
- MES structure
- MES volume
- NQ
- VIX baseline
- US10Y
- ZN
- DXY
- BANK once live and validated

Conditional / high-value:
- CL
- GC
- additional vol/stress meters

Slow regime/model overlays:
- WALCL
- RRPONTSYD
- SOFR
- NFCI
- HY/IG OAS
- EPU / uncertainty family

### Event-risk engine required set

These belong in event logic, not flat static features:
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
- Treasury auction stress later if structured cleanly

### News-flow architecture

Approved boundary:
- AI may be used upstream for enrichment only
- trigger consumes deterministic downstream scores only

Required category coverage:
- Fed / central bank
- inflation
- labor
- growth
- geopolitics
- tariffs / trade
- energy
- banking / credit
- volatility / market stress

## Trigger-State Direction

The key trigger problem is not simple breakout detection. It is distinguishing:
- accepted break / continuation
- failed break / reclaim
- liquidity sweep / stop run
- ambiguous no-trade

Required trigger-state inputs include:
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

Important:
- volume must be part of sweep detection
- do not reduce this to price-only breach logic

## Tick vs 1m Position

Approved direction:
- V1 should proceed on `1m` structure + volume + intermarket + event/news context
- do **not** block V1 waiting for tick modeling
- tick / order-flow augmentation is a later V2 enhancement

## AI Governance

Allowed AI use:
- news enrichment
- reasoning / explanation
- summarization

Disallowed AI ownership:
- trigger math
- structure classification source of truth
- entry / stop / TP logic
- core scoring truth

## Current Gaps Still Open In The Governance Package

These were the latest corrections requested from Codex and should be checked in the next chat:

1. Correct vol-complex taxonomy
- `VXVCLS` is not `VVIX`
- term structure and vol-of-vol must be treated as different signals

2. Explicit `CL` / `GC` classification
- oil and gold must not remain implicit
- they need explicit roles in trigger vs model vs regime

3. Explicit degraded-state contract
- define what becomes `degraded_no_trade`
- define what can degrade to context-only
- define what must hard-fail trigger execution
- define freshness SLAs per feed family

4. News-engine governance needs more detail
- source weighting
- dedupe
- freshness windows
- novelty
- post-headline reaction linkage to MES / NQ / VIX / US10Y / ZN

5. Data availability verification is now mandatory
- Codex must verify actual obtainability from:
  - Databento current subscription
  - FRED
  - Yahoo only as reluctant fallback
  - options-derived proxies where needed

6. Local-training ownership plan is mandatory
- all heavy training/backtest/feature-build/derived-table work must be local-first and script-owned
- no cloud-routing by default

## Actual Data Paths To Use

Verified paths on this machine:
- `/Volumes/Satechi Hub/Databento Data Dump`
- `/Volumes/Satechi Hub/Databento Data Dump/Options/definitions`
- `/Volumes/Satechi Hub/ZINC-FUSION-V15`

Important correction:
- `/Volumes/ZINC Fusion V15` does **not** exist here
- use the `/Volumes/Satechi Hub/...` paths instead

## What Codex Still Needs To Deliver

Before more implementation is approved, Codex needs to return a final governance package that includes:

1. MACD Spec Review
2. Volume Spec Review
3. Dual Rates Design (`US10Y + ZN`)
4. BANK / Financials Acquisition Plan
5. Event-Risk Engine Scope
6. News-Flow Engine Architecture
7. Vol / Stress Complex Inventory
8. Sweep / Acceptance Trigger-State Design
9. Tick vs 1m Phased Design
10. Trigger Training / Backtest Design
11. Training Simplicity Rule
12. AI Governance
13. Placeholder Removal Inventory
14. Data Source Availability Matrix
15. Local Training Ownership Plan
16. Updated Clear Recommendation

## Exact Current Working-Tree Change Set

Files currently dirty/new:
- `scripts/compute-volume-features.py`
- `src/inngest/functions/compute-signal.ts`
- `src/lib/trade-features.ts`
- `src/lib/runtime-volume-features.ts`
- `src/lib/volume-contract.ts`
- `docs/volume-feature-contract.md`

What those changes do:
- remove deployed runtime Python dependency for volume
- move runtime volume calculation into TypeScript
- centralize canonical volume contract/defaults
- keep Python script for local/offline diagnostics
- document runtime volume contract

## Recommended Next Step In New Chat

1. Have Codex return the revised governance package with the remaining corrections folded in.
2. Review that package against the open gaps above.
3. If approved, create the next bounded implementation brief.
4. Only then allow narrowly scoped coding.

Do **not** jump directly into broad trigger rewrites from this breakpoint.

## Copy/Paste Restart Prompt

Use this first in the next chat:

```text
We are resuming pre-Phase-1 trigger governance work in /Volumes/Satechi Hub/rabid-raccoon.

Read this handoff first:
/Volumes/Satechi Hub/rabid-raccoon/docs/handoffs/2026-03-07-pre-phase1-trigger-governance-handoff.md

Current state:
- main is at 01bef05
- there is uncommitted volume-runtime work in the tree
- do not start broad implementation
- do not start Phase 2 capability buildout

Your first job is to continue from the handoff, not to improvise new scope.
```
