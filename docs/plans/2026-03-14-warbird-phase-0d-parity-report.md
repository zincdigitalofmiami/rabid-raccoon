# Warbird Phase 0D Parity Report

**Date:** 2026-03-14  
**Status:** Complete  
**Scope:** compare legacy `advanceBhgSetups(...)`, delegated `advanceWarbirdSetups(...)`, and pure `advanceWarbirdSetupsPure(...)` on the same fixed input window before any production caller flip

---

## Verification Command

```bash
node --import tsx scripts/warbird-parity-report.ts
```

Supporting tests:

```bash
node --import tsx --test scripts/warbird-engine.test.ts
node --import tsx --test scripts/warbird-setup-recorder.test.ts
```

---

## Exact Input Window

**Fixture name:** `fixed-fixture-12-bar-touch-hook-go-window`

**Candle window**

| Bar | Time | Open | High | Low | Close | Volume |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 6998 | 7000 | 6994 | 6996 | 1100 |
| 2 | 2 | 6996 | 6998 | 6992 | 6994 | 1080 |
| 3 | 3 | 6994 | 6995 | 6948 | 6954 | 1700 |
| 4 | 4 | 6954 | 6962 | 6952 | 6961 | 1650 |
| 5 | 5 | 6961 | 6963 | 6958 | 6960 | 980 |
| 6 | 6 | 6960 | 6964 | 6957 | 6962 | 1020 |
| 7 | 7 | 6962 | 6965 | 6960 | 6963 | 1030 |
| 8 | 8 | 6963 | 6966 | 6961 | 6964 | 1040 |
| 9 | 9 | 6964 | 6967 | 6962 | 6965 | 1050 |
| 10 | 10 | 6965 | 6968 | 6963 | 6966 | 1060 |
| 11 | 11 | 6966 | 6969 | 6964 | 6967 | 1070 |
| 12 | 12 | 6967 | 6970 | 6965 | 6968 | 1080 |

**Fib input**

- `isBullish = true`
- `anchorHigh = 7000`
- `anchorLow = 6900`
- active retracement levels used by both engines:
  - `0.5 -> 6950`
  - `0.618 -> 6961.8`
  - `1.236 -> 7023.6`
  - `1.618 -> 7061.8`

**Measured-move input**

- `[]`
- The same empty measured-move array was passed into all three engine paths.

---

## Result Summary

| Comparison | Legacy count | Warbird count | Match | Differences |
|---|---:|---:|---|---:|
| Legacy vs delegated `advanceWarbirdSetups(...)` | 4 | 4 | Yes | 0 |
| Legacy vs pure `advanceWarbirdSetupsPure(...)` | 4 | 4 | Yes | 0 |

**Observed setup states**

| Setup ID | Direction | Phase | Entry | Stop | TP1 | TP2 |
|---|---|---|---:|---:|---:|---:|
| `BEARISH-0.5-2` | BEARISH | CONTACT | - | - | - | - |
| `BEARISH-0.618-2` | BEARISH | CONFIRMED | - | - | - | - |
| `BULLISH-0.5-2` | BULLISH | CONTACT | - | - | - | - |
| `BULLISH-0.618-2` | BULLISH | TRIGGERED | 6962 | 6959.75 | 7023.5 | 7061.75 |

---

## Difference Classification

No setup-count, phase-transition, stop-loss, target, or metadata differences were observed on this fixed window.

- `delegated vs legacy`: no findings
- `pure vs legacy`: no findings

Because there were zero observed differences, there were no `bug`, `intentional improvement`, or `unresolved` classifications to assign.

---

## Interpretation

- The exported Warbird seam remains honest about its bootstrap mode: `WARBIRD_ENGINE_MODE = "legacy-bhg-delegation"`.
- The delegated public Warbird path currently preserves legacy behavior exactly on the tested window.
- The pure Warbird-owned advancement path also preserves legacy behavior exactly on the tested window.
- This closes the Phase `0D` requirement for a written parity report before caller flip planning.

---

## Residual Risk

- This report proves parity on the pinned fixed fixture only. It does not by itself prove parity across all historical MES windows.
- Any production caller flip still depends on the broader Phase 4 route-consumer work and the active v1 contract/mismatch closures in the canonical checklist.
