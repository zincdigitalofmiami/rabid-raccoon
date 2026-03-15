# Warbird Phase 0E Data Contract

**Date:** 2026-03-14  
**Status:** Complete  
**Scope:** define the explicit logical mapping between legacy BHG physical storage and the additive Warbird runtime surface without pretending the database is already destructively renamed

---

## Current Physical Truth

The repo is in an additive transition state. The runtime can speak Warbird, but physical storage and several training surfaces still speak BHG.

**Physical DB truth**

- Prisma model: `BhgSetup`
- Table: `bhg_setups`
- Enum: `BhgPhase`
- Active transition write path: `src/lib/warbird-setup-recorder.ts`

**Legacy runtime truth still present**

- `src/lib/bhg-engine.ts`
- `src/lib/bhg-setup-recorder.ts`
- `src/lib/trigger-candidates.ts`
- `src/lib/outcome-tracker.ts`
- `scripts/build-bhg-dataset.ts`
- `scripts/build-regime-lookup.ts`
- `scripts/train-fib-scorer.py`

**Additive Warbird truth already present**

- `src/lib/warbird-engine.ts`
- `src/lib/warbird-setup-recorder.ts`
- `scripts/warbird-engine.test.ts`
- `scripts/warbird-setup-recorder.test.ts`

---

## Logical Model Mapping

### Runtime setup contract

| Legacy surface | Warbird surface | Contract |
|---|---|---|
| `BhgSetup` | `WarbirdSetup` | Same setup lifecycle shape during transition; Warbird adds naming clarity and optional `legacyBridge` metadata on delegated outputs |
| `GoType` | `WarbirdGoType` | Same values: `BREAK`, `CLOSE` |
| `SetupPhase` | `WarbirdPhase` | Same runtime phase labels: `AWAITING_CONTACT`, `CONTACT`, `CONFIRMED`, `TRIGGERED`, `EXPIRED`, `INVALIDATED` |
| `SetupDirection` | `WarbirdDirection` | Same values: `BULLISH`, `BEARISH` |

### Runtime bridge behavior

| Surface | Current behavior | Why |
|---|---|---|
| `advanceWarbirdSetups(...)` | Delegates to `advanceBhgSetups(...)` and annotates `legacyBridge` | Keeps the public Warbird seam truthful and stable while parity is proven |
| `advanceWarbirdSetupsPure(...)` | Runs a fully Warbird-owned state machine and target computation path | Provides the non-delegating parity target for later caller or export flips |
| `toLegacyBhgSetup(...)` | Drops Warbird-only bridge metadata and normalizes to legacy setup shape | Enables exact parity comparison against legacy outputs |

---

## Persistence Mapping

### Triggered setup persistence

`src/lib/warbird-setup-recorder.ts` is the authoritative additive bridge for live triggered setup persistence.

| Warbird runtime state | Physical DB write |
|---|---|
| `WarbirdSetup.phase = "TRIGGERED"` | `BhgSetup.phase = "GO_FIRED"` |
| `WarbirdSetup.direction` | `BhgSetup.direction` |
| `WarbirdSetup.fibLevel` / `fibRatio` | `BhgSetup.fibLevel` / `fibRatio` |
| `WarbirdSetup.touch*` / `hook*` / `go*` | same fields on `BhgSetup` |
| `WarbirdSetup.entry` / `stopLoss` / `tp1` / `tp2` | same fields on `BhgSetup` |
| optional scoring context | `pTp1`, `pTp2`, `correlationScore`, `vixLevel`, `modelVersion` |

**Bridge metadata returned by the recorder**

- `physicalTable = "bhg_setups"`
- `physicalPhaseEnum = "BhgPhase"`
- `mappedPhase = "GO_FIRED"`
- `strategy = "warbird-input-mapped-to-legacy-bhg-model"`

### Outcome-phase mapping

`src/lib/outcome-tracker.ts` still owns the post-trigger physical phase resolution on `bhg_setups`.

| Outcome condition | Physical `BhgPhase` |
|---|---|
| Triggered and waiting on outcome window | `GO_FIRED` |
| Stop loss hit first | `STOPPED` |
| TP1 hit, TP2 not hit | `TP1_HIT` |
| TP2 hit | `TP2_HIT` |
| No target or stop reached in window | `EXPIRED` |

This remains a physical BHG enum during transition. The Warbird runtime contract must not pretend these rows already live in a separate `warbird_setups` table or `WarbirdPhase` enum.

---

## Canonical Setup Identity

The stable setup identity contract is shared across legacy and Warbird paths through `src/lib/setup-id.ts`.

**Current canonical setup ID format**

```text
M15|<direction>|<fibRatio>|<fibLevel>|<eventEpochSeconds>
```

**Fields used**

- timeframe: default `M15`
- direction
- `fibRatio.toFixed(3)`
- `fibLevel.toFixed(6)`
- first available event epoch from `candidateTime`, `goTime`, `hookTime`, `touchTime`, then `createdAt`

This ID is the bridge key for:

- route emissions
- chart and card stability across polls
- `bhg_setups.setupId`
- `scored_trades.setupHash`
- Warbird-to-legacy recorder mapping

---

## Dataset Contract

### Current dataset truth

| Path | Reality | Contract |
|---|---|---|
| `datasets/autogluon/bhg_setups.csv` | Missing by design | Treat as a retired legacy filename, not a file to restore |
| `datasets/autogluon/warbird_setups.csv` | Exists in repo | This is the correct Warbird-aligned setup dataset filename going forward |

### Current consumer drift

These surfaces still point at the retired legacy dataset name and therefore remain drift that must be handled explicitly:

- `scripts/build-regime-lookup.ts`
- `src/lib/ml-baseline.ts`
- `scripts/train-fib-scorer.py`
- any setup-dataset generation lane still emitting `bhg_setups.csv`

### Working contract for the Warbird setup dataset

| Contract item | Decision |
|---|---|
| Canonical Warbird setup dataset path | `datasets/autogluon/warbird_setups.csv` |
| Legacy `bhg_setups.csv` recovery | Do not recover it |
| Legacy consumers | Rename, park, or explicitly mark deferred; do not silently leave them broken |
| Role in Warbird v1 | Supporting / deferred only; setup-outcome ML is not active v1 scope |

---

## Consumer and Ownership Boundaries

### Active v1 owner surfaces

| Surface | Role |
|---|---|
| `src/lib/warbird-engine.ts` | additive Warbird runtime engine surface |
| `src/lib/warbird-setup-recorder.ts` | additive Warbird -> legacy DB bridge |
| `scripts/warbird-engine.test.ts` | parity and stability proof for the additive engine |
| `scripts/warbird-setup-recorder.test.ts` | recorder mapping proof |

### Explicitly not yet migrated

| Surface | Status |
|---|---|
| `prisma/schema.prisma` physical rename | Not done; additive transition only |
| `bhg_setups` table rename | Not done |
| `BhgPhase` -> `WarbirdPhase` physical enum rename | Not done |
| setup-outcome scorer activation | Deferred beyond v1 |
| legacy setup dataset consumers | Still drift, must be handled explicitly |

---

## Verification

```bash
rg -n "Bhg|bhg_|GO_FIRED" prisma/schema.prisma src/lib scripts src/app/api/setups src/inngest indicators
node --import tsx --test scripts/warbird-setup-recorder.test.ts
```

Repo facts used in this contract:

- `prisma/schema.prisma` still defines `BhgSetup`, `BhgPhase`, and `@@map("bhg_setups")`
- `src/lib/warbird-setup-recorder.ts` explicitly maps Warbird-triggered setups to legacy `GO_FIRED`
- `src/lib/outcome-tracker.ts` still resolves physical phases on `bhg_setups`
- `scripts/build-regime-lookup.ts`, `src/lib/ml-baseline.ts`, and `scripts/train-fib-scorer.py` still reference `bhg_setups.csv`

---

## Conclusion

Phase `0E` is closed as a contract-definition block:

- the runtime, persistence, phase, identity, and dataset mappings are now explicit
- the additive Warbird bridge is documented honestly against current physical truth
- the remaining legacy-name surfaces are classified as active drift, not hidden assumptions

This does **not** mean the destructive rename is approved or complete. It means the current transition state is now documented precisely enough for later execution without guesswork.
