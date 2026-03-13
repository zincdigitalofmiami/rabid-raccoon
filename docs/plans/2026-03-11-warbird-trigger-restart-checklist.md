# 2026-03-11 Warbird Trigger/Decision Restart Checklist

**Status:** Active restart baseline  
**Scope:** Trigger engine + decision engine (current phase)  
**Mode:** Deterministic first, data-truth first, no placeholder/fallback logic

## 0. Architecture Lock (Current)

1. Trigger runtime serving remains frontend-side on Vercel/Prisma.
2. Heavy processing (feature math/correlation/replay/validation) is local-first.
3. Cloud is the serving/runtime data surface for dashboard reads.
4. Single writer per table is mandatory; no dual-writer drift.

## 0.1 Canonical Operational Map

Use this file as the live execution map for what hits where and when:

- [2026-03-11-trigger-data-hit-map.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-11-trigger-data-hit-map.md)

## 1. Source-Of-Truth Docs

1. [2026-03-09-trigger-news-regime-spec.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-news-regime-spec.md)
2. [2026-03-09-trigger-core-contract.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-trigger-core-contract.md)
3. [2026-03-09-runtime-data-flow-audit.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-09-runtime-data-flow-audit.md)
4. [2026-03-08-pre-phase1-trigger-governance-approval.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/handoffs/2026-03-08-pre-phase1-trigger-governance-approval.md)
5. [2026-03-11-trigger-data-hit-map.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-11-trigger-data-hit-map.md)
6. [2026-03-11-research-capture-ledger.md](/Volumes/Satechi%20Hub/rabid-raccoon/docs/plans/2026-03-11-research-capture-ledger.md)

## 2. Restart Objective

Replace BHG as the base trigger generator and stand up the contract-defined trigger/decision pipeline with verified data inputs:

- Base trigger candidate
- News/regime gate
- Correlation confirmation
- Volume/liquidity confirmation
- Price-action acceptance/failure confirmation
- Deterministic decision (`BLOCK` / `DEFER` / `ALLOW` / `PRIORITIZE`)

## 3. Confirmed Current Mismatch (Must Be Cleared)

1. Live trigger candidate generation still routes through `advanceBhgSetups`.
2. Trigger contract expects `CORRELATION_SET` with approved basket (`MES,NQ,RTY,ZN,CL,6E`) and explicit regime-aware handling.
3. Runtime volume contract is still thin relative to contract states (`THIN/BALANCED/EXPANSION/EXHAUSTION/ABSORPTION`).
4. Live price-action acceptance/sweep/trap states are not yet first-class runtime outputs.
5. Event/news model is not yet fully aligned with `CLEAR/APPROACHING/BLACKOUT/SHOCK/DIGESTION/SETTLED`.

## 4. Execution Lanes

## Lane A — Data/Schema/Feed Truth (Parallelizable)

1. Verify DB role membership for `CORRELATION_SET`, `ANALYSIS_DEFAULT`, and `OPTIONS_PARENT` against snapshot parity.
2. Verify ingestion freshness for:
   - `mkt_futures_mes_1m`
   - `mkt_futures_mes_15m`
   - `mkt_futures_mes_1h`
   - `mkt_futures_mes_4h`
   - `econ_calendar`
   - `news_signals`
   - `mkt_futures_1d` (trigger basket symbols)
   - `mkt_options_statistics_1d`
   - `mkt_options_ohlcv_1d`
3. Resolve migration/state drift before trigger refactor proceeds.
4. Verify `/api/inngest` health and identify current scheduler blockers.
5. Produce a single short “data readiness” note with concrete timestamps and pass/fail by table.
6. Fix ingestion run-contract mismatches so run status and counters are trustworthy (`ingestion_runs` parity across scripts).
7. Confirm local-vs-cloud ownership intent and publish cadence in writing (no implied dual ownership).

## Lane B — Trigger Base Replacement

1. Add a trigger-base engine module that does **not** depend on `bhg-engine`.
2. Keep `TriggerCandidate` contract stable where possible; add fields only if contract-required.
3. Port required price-action concepts into live runtime outputs:
   - acceptance/rejection/failed-break
   - sweep/fakeout/trap/whipsaw risk
   - blocker density + open-space + wick/body quality
4. Keep AI strictly explanatory; zero AI authority over trigger state machine.

## Lane C — Decision Engine Wiring

1. Implement ordered evaluation:
   - news veto
   - liquidity/volume veto
   - price-action veto
   - correlation downgrade/upgrade
   - prioritization
2. Emit explicit veto/downgrade reasons per candidate.
3. Ensure `BLACKOUT` and `SHOCK` handling are deterministic hard constraints unless explicitly changed by approved spec update.
4. Ensure each decision includes traceable context payloads for:
   - news state
   - correlation state
   - volume/liquidity state
   - price-action state

## 5. Delegation Package For Second Agent

Assign the second agent Lane A with these exact deliverables:

1. Role parity report:
   - DB `CORRELATION_SET` membership
   - snapshot membership
   - mismatch list
2. Freshness report:
   - max timestamp per required table
   - stale threshold breaches
3. Ingestion health report:
   - stuck/failed runs by job
   - `/api/inngest` request health snapshot
4. Databento schema-fit report for trigger volume/fingerprint expansion:
   - L1/L2/trades/actions availability for MES/related symbols
   - no OPRA assumptions
   - what is immediately usable vs later

## 6. Hard Rules During Implementation

1. No hardcoded symbol lists outside symbol registry roles.
2. No destructive schema changes.
3. No placeholder/fallback logic in trigger-critical paths.
4. One fix at a time on `main`; each change verified before next.
5. Preserve MES chart frontend contract; backend/data wiring only.

## 7. Definition Of Done (Restart Milestone)

1. Trigger candidate generation no longer depends on `advanceBhgSetups`.
2. Decision pipeline emits contract states and deterministic decisions with reasons.
3. Correlation source is role-driven and aligned with approved basket.
4. Volume and price-action states are first-class runtime outputs (not single booleans).
5. Event/news states include required contract states and gating behavior.
6. Data readiness checks are green and documented with timestamps.
7. Hit-map document is current and explicit about owner, destination DB/table, cadence, and latest timestamps.
