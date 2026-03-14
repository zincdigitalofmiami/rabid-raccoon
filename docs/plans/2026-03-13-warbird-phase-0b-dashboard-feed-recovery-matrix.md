# Warbird Phase 0B Dashboard Feed Recovery Matrix

**Date:** 2026-03-13  
**Status:** Route audit completed; `0B-B1` through `0B-B5` and `0B-B7` hardening applied on `main`  
**Scope:** Dashboard/feed recovery status and fix ownership for active API surfaces

---

## Phase 0B Owner Blocks

| Block | Scope | Routes |
|---|---|---|
| `0B-B1` | Feed freshness and empty-data response contract | `/api/gpr`, `/api/pivots/mes`, `/api/live/mes15m` |
| `0B-B2` | Setups route hardening at trigger seam | `/api/setups` |
| `0B-B3` | Forecast degradation contract (DB + AI dependency handling) | `/api/forecast` |
| `0B-B4` | Inngest served-surface vs runtime-health split | `/api/inngest` |
| `0B-B5` | Upcoming trades cache warm/cold resilience | `/api/trades/upcoming` |
| `0B-B7` | MES chart freshness owner-path proof | `/api/live/mes15m` + authoritative MES 1m writer |

---

## Route Matrix

| Route | Status | Owner file(s) | Direct data dependency | Exact current failure mode or fragility | Fix owner block | Verification probe or command |
|---|---|---|---|---|---|---|
| `/api/gpr` | `green` | `src/app/api/gpr/route.ts` | Prisma reads from `geopoliticalRisk` (`GPRD`, `GPRD_ACT`, `GPRD_THREAT`) | Deterministic empty-source path now returns `404` with `meta.status="empty-source"`; success payload keeps existing fields and adds freshness metadata (`meta.status`, `sourceAgeDays`, `isStale`, index coverage); runtime failures remain explicit `500` with `meta.status="runtime-failure"` | `0B-B1` (implemented) | `curl -si http://localhost:3000/api/gpr \| head -n 20` and `curl -s http://localhost:3000/api/gpr \| jq '{current: .current.date, status: .meta.status, stale: .meta.isStale, error}'` |
| `/api/pivots/mes` | `green` | `src/app/api/pivots/mes/route.ts` | Prisma reads from `mktFuturesMes1d` for prior day/week/month/year OHLC | Zero-pivot and partial-pivot states are now explicit via `meta.status` (`empty`, `partial`, `full`) plus per-timeframe coverage (`meta.timeframes` with source bars/date range/line count); existing `pivots` array contract preserved; runtime failures remain explicit `500` with `meta.status="runtime-failure"` | `0B-B1` (implemented) | `curl -si http://localhost:3000/api/pivots/mes \| head -n 20` and `curl -s http://localhost:3000/api/pivots/mes \| jq '{status: .meta.status, available: .meta.availableTimeframes, total: .meta.totalTimeframes, pivots: (.pivots\|length)}'` |
| `/api/setups` | `yellow` | `src/app/api/setups/route.ts`, `src/lib/mes-15m-derivation.ts`, `src/lib/trigger-candidates.ts` | MES 1m -> derived MES 15m via `readLatestMes15mRowsPrefer1m`, then `generateTriggerCandidates` | Deterministic route-state buckets are now explicit via `meta.status`: `insufficient-source-data` (`503`), `derivation-failure` (`500`), `trigger-generation-failure` (`500`), `empty-success` (`200`), `full-success` (`200`); success payload fields are preserved; trigger seam is explicit in `meta.engine` and still legacy-adapter backed pending `0C/0D/4` | `0B-B2` (implemented), then `0C/0D/4` for engine replacement after parity | `curl -si http://localhost:3000/api/setups \| head -n 30` and `curl -s http://localhost:3000/api/setups \| jq '{status: .meta.status, engine: .meta.engine, setups: (.setups\|length), error}'` |
| `/api/live/mes15m` | `green` | `src/app/api/live/mes15m/route.ts`, `src/lib/mes-live-queries.ts`, `src/inngest/functions/mkt-mes-1m.ts` | Databento-backed MES 1m ingestion -> stored `mkt_futures_mes_1m` -> local 1m->15m aggregation in route | Existing chart-consumed fields and semantics are preserved (`points`, `live`, `changed`, `fingerprint`); owner-path freshness attribution is now explicit and machine-readable via additive `meta.attribution` and `meta.ownerPath` fields. The route can now distinguish no-recent-1m-row conditions (`no-recent-1m-rows`), owner lag (`owner-path-freshness-lag`), and reader/runtime failure (`reader-path-runtime-failure`) while keeping runtime failures explicit and chart contract unchanged. | `0B-B1` + `0B-B7` (implemented) | `curl -si "http://localhost:3000/api/live/mes15m?poll=1&bars=12" \| head -n 30` and `curl -s "http://localhost:3000/api/live/mes15m?poll=1&bars=12" \| jq` |
| `/api/forecast` | `yellow` | `src/app/api/forecast/route.ts`, `src/lib/fetch-candles.ts`, `src/lib/forecast.ts` | Cross-symbol candle fetches from DB (`fetchCandlesForSymbol`, `fetchDailyCandlesForSymbol`) plus AI forecast generation | Deterministic route-state metadata is now explicit: `full-success` (`200`), `data-unavailable` (`503`), `ai-unavailable` (`500`), and `runtime-failure` (`500`); failure sources are machine-distinguishable via `meta.source` (`intraday-market-data`, `daily-market-context`, `ai-provider`, `forecast-route`); existing success payload fields are preserved and no deterministic non-AI fallback forecast is introduced | `0B-B3` (implemented), coordinated with `4` | `curl -si "http://localhost:3000/api/forecast?refresh=true" \| head -n 30` and `curl -s "http://localhost:3000/api/forecast?refresh=true" \| jq '{status: .meta.status, source: .meta.source, error}'` |
| `/api/inngest` | `green` | `src/app/api/inngest/route.ts`, `src/inngest/index.ts` | Inngest `serve()` surface with explicit `functions` list in route | Probe-safe contract now exists at `GET /api/inngest?probe=health`: route serve health is explicit (`status="serve-surface-healthy"`), runtime execution health is explicitly unverified (`runtimeHealth.status="unknown"`), and served-vs-exported drift is surfaced via `registrySurface` (`exportedNotServed`, `servedNotExported`, `hasDrift`) without touching normal `GET/PUT/POST` serve traffic | `0B-B4` (implemented) | `curl -si "http://localhost:3000/api/inngest?probe=health" \| head -n 30` and `curl -s "http://localhost:3000/api/inngest?probe=health" \| jq` |
| `/api/trades/upcoming` | `green` | `src/app/api/trades/upcoming/route.ts`, `src/inngest/functions/compute-signal.ts` | In-memory `signalCache` key `upcoming-trades` written by `compute-signal` | Deterministic cache-state contract is now explicit: `meta.status` distinguishes `warm-cache`, `cold-cache`, `stale-cache`, and `runtime-failure`; freshness is machine-readable via `meta.cacheAgeSeconds`, `meta.isStale`, and cadence/recovery metadata; route remains cache-backed only (no DB fallback / no route-triggered compute); non-success/degraded states are no-store to prevent public caching of cold/stale/failure responses | `0B-B5` (implemented) | `curl -si http://localhost:3000/api/trades/upcoming \| head -n 30` and `curl -s http://localhost:3000/api/trades/upcoming \| jq '{status: .meta.status, stale: .meta.isStale, age: .meta.cacheAgeSeconds, error}'` |

---

## Notes for Phase Handoff

- No route is left as unknown.
- Every non-green route has a concrete owner block.
- `/api/setups` remains coupled to legacy trigger internals until Phase `0C/0D/4` execution flips callers to verified Warbird outputs.
- `/api/inngest` now exposes the split contract directly in-route via `?probe=health`; downstream runtime execution remains a separate verification surface by design.
