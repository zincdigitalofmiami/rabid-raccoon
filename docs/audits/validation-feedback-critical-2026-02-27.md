# Critical Validation Feedback & Corrections
**Date:** 2026-02-27  
**Status:** ACTIVE — All issues require resolution before implementation begins

---

## TABLE OF CONTENTS
1. [Database Audit Corrections](#database-audit-corrections)
2. [Feature Engineering Spec Issues](#feature-engineering-spec-issues)
3. [ML Research Report Issues](#ml-research-report-issues)
4. [Trade Feedback Spec Issues](#trade-feedback-spec-issues)
5. [Cross-Document Consistency Issues](#cross-document-consistency-issues)
6. [Priority Matrix](#priority-matrix)
7. [Action Items by Phase](#action-items-by-phase)

---

## DATABASE AUDIT CORRECTIONS

### Error #1: Prisma Error Type (CRITICAL)
**Location:** Recommendation #8 in Database Audit  
**Severity:** P0 — Dead code path  

❌ **INCORRECT:**
```typescript
if (error instanceof Prisma.PrismaClientConnectedError) {
  // This class does NOT EXIST in Prisma API
  // Catch block will silently fail
}
```

✅ **CORRECT:**
```typescript
if (error instanceof Prisma.PrismaClientInitializationError) {
  return NextResponse.json({ error: 'Database unavailable' }, { status: 503 })
}
```

**Full correct error types to catch:**
- `PrismaClientKnownRequestError` — query validation/constraint violations
- `PrismaClientUnknownRequestError` — unexpected server errors
- `PrismaClientRustPanicError` — engine panics
- `PrismaClientInitializationError` — connection & auth failures ✅
- `PrismaClientValidationError` — argument validation

**Action:** Update audit recommendation before implementing error handler.

---

### Error #2: Finding #5 Self-Contradiction
**Location:** Finding #5 "Missing composite indexes on options tables"  
**Severity:** P1 — Misleading diagnosis

❌ **FINDING STATES:**
> "Missing composite indexes on options tables" → then shows `@@unique([parentSymbol, eventDate])` already present

✅ **ACTUAL GAP:**
The **unique constraint** already exists. The missing piece is a **non-unique composite index for range queries**:

```sql
-- Currently have:
@@unique([parentSymbol, eventDate], map: "mkt_options_statistics_1d_parent_date_key") ✅

-- Miss for dashboard range queries like:
-- WHERE parentSymbol = 'ES.OPT' AND eventDate BETWEEN ? AND ?
@@index([parentSymbol, eventDate], map: "mkt_options_statistics_1d_parent_date_idx")  ← ADD THIS
```

**Action:** Reframe finding to specify non-unique index gap for range-query optimization.

---

### Error #3: Config File Confusion (Recommendation #2)
**Location:** Recommendation #2 "Add pool size config to prisma.config.ts"  
**Severity:** P1 — Implementation in wrong file

❌ **INCORRECT INSTRUCTION:**
> "Add to prisma.config.ts with datasource db {...} block showing pool config"

✅ **CORRECT LOCATIONS:**
- **`prisma.config.ts`**: Controls CLI behavior (migrations, studio)
- **Connection string params**: Runtime pool tuning goes here
- **`schema.prisma`**: Declares data model (not runtime pool config)

**Accelerate pool tuning example:**
```
DATABASE_URL=prisma+postgres://accelerate.prisma-data.net/?api_key=...
  &schema=public
  &pool_timeout=30          ← Pool timeout (seconds)
  &statement_timeout=30000  ← Statement timeout (ms)
```

**Action:** Clarify pool config belongs in connection string `.env` variables, not schema files.

---

### Finding #7: Accelerate Timeout Risk (UNDERSTATED)
**Location:** Finding #7 "Accelerate 5-second transaction limit"  
**Severity:** P1 → **P1 ELEVATED** — Silent failure mode

⚠️ **ISSUE ESCALATION:**
Finding correctly identified 5-second limit but **severity was MEDIUM**. This needs to be **P1 HIGH RISK** because:

- Accelerate doesn't always throw clean timeout error
- **Connection closes mid-transaction** without clear failure signal
- Batch operations can silently leave partial writes
- No automatic retry behavior

**Mitigation required:**

```typescript
// BEFORE sending batch to Accelerate, validate fit within 5s window
const MAX_BATCH_SIZE_SAFE = 100  // Empirically determined

async function batchUpsertWithTimeout(operations: any[], maxBatchSize = MAX_BATCH_SIZE_SAFE) {
  if (operations.length > maxBatchSize) {
    throw new Error(
      `Batch size ${operations.length} exceeds Accelerate 5s limit. ` +
      `Max safe: ${maxBatchSize}. Consider chunking.`
    )
  }
  
  try {
    const startMs = Date.now()
    const result = await prisma.$transaction(operations, {
      timeout: 4500,  // 4.5s timeout (safety margin below Accelerate 5s)
    })
    const elapsedMs = Date.now() - startMs
    
    if (elapsedMs > 4000) {
      console.warn(`[transaction] slow: ${elapsedMs}ms for ${operations.length} ops`)
    }
    
    return result
  } catch (error) {
    if (error instanceof Prisma.PrismaClientValidationError) {
      throw new Error(`Transaction validation failed: ${error.message}`)
    }
    throw error
  }
}
```

**Action:** 
1. Add pre-flight batch size validation
2. Set explicit 4.5s timeout on all Accelerate transactions
3. Log slow transactions (> 4s) for monitoring

---

## FEATURE ENGINEERING SPEC ISSUES

### P0 BLOCKER: SOX.c.0 Doesn't Exist
**Location:** Phase 3, `crossAssetSymbols` array  
**Severity:** P0 — Silent data corruption

❌ **PROBLEM:**
- SOX = Philadelphia Semiconductor **INDEX** (cash only, not tradeable)
- No futures contract `SOX.c.0` exists for Databento to return
- If Databento returns anything, it's synthetic/incorrect
- Silent data quality failure in Phase 3 cross-asset features

📋 **OPTIONS:**
1. **Replace with `SMH`**: VanEck Semiconductor ETF (NASDAQ tradeable proxy)
2. **Drop entirely**: If not critical to correlation universe

**Action:** Confirm with Kirk which approach; update `crossAssetSymbols` before Phase 3 begins.

---

### P1 BUG: Activity Series Count Mismatch
**Location:** Feature Engineering Spec header + Activity section  
**Severity:** P1 — Scope ambiguity

❌ **DISCREPANCY:**
Header claims: "5 new Activity series"  
Spec lists: **6 series**
- GDPC1 (GDP)
- RSXFS (Retail Sales)
- UMCSENT (Consumer Sentiment)
- INDPRO (Industrial Production)
- BOPGSTB (Trade Balance)
- IMPCH (China Imports)

**QUESTION:** Is duplication of BOPGSTB + IMPCH intentional given you already track FX stress and commodity stress?

**Action required:** Kirk to confirm whether count is 5 or 6, and resolve any duplication.

---

### P1 PERFORMANCE: Vectorization Required for 15m Builder
**Location:** Feature Engineering Spec, "Helper Functions" section  
**Severity:** P1 — Phase 2 build time will be prohibitive

❌ **CURRENT PATTERN:**
```typescript
for (const candle of candles) {  // 46,800 candles for 15m
  stats.push({
    correlation: rollingCorrelation(closes, i, 20),  // O(20) per call
    percentile: computePercentile(volumes, i, 100),  // O(100) per call
    // ... 30+ more rolling calcs
  })
}
// Total: 46,800 * O(150) = 7M+ ops, sequential
```

✅ **REQUIRED PATTERN:**
```typescript
// Pre-compute rolling stats OUTSIDE candle loop (vectorized)
const precomputed = {
  correlation20: computeRollingCorrelationFast(closes, window=20),  // O(n) once
  percentile100: computeRollingPercentileFast(volumes, window=100), // O(n) once
  // ... all rolling stats pre-computed in parallel
}

// Then reference pre-computed values in loop
for (let i = 0; i < candles.length; i++) {
  stats.push({
    correlation: precomputed.correlation20[i],
    percentile: precomputed.percentile100[i],
  })
}
```

**Impact estimate:**
- Current (inline): 15–30 min build time (unacceptable)
- After vectorization: 2–5 min build time (acceptable)

**Action:** Implement vectorized rolling stat computation before Phase 2 work starts.

---

### P1 MEMORY CONCERN: 15m Dataset Array Storage
**Location:** Feature Engineering Spec, Data Structure section  
**Severity:** P1 — Feasibility check required

⚠️ **MEMORY PRESSURE:**
- 1h dataset: ~11,700 rows
- 15m dataset: ~46,800 rows (4x larger)
- 30+ FRED series stored as `Float64Array` per series
  - Each array: 46,800 * 8 bytes = ~375 KB
  - 30 arrays = ~11.25 MB FRED data alone
- Plus 100+ computed feature arrays in parallel

**Estimate:** Total heap for 15m dataset build ~150–250 MB

**Risks:**
- Node.js default heap: 1.4 GB (safe margin exists)
- But concurrent operations could exceed limits
- No explicit memory management in current builders

**Action:** 
1. Benchmark 15m dataset build on target machine (Apple Silicon)
2. Monitor peak heap during build
3. If exceeds 500 MB, implement streaming/chunking

---

### P2 DEPENDENCY: FRED Point-in-Time Refactor is Breaking Change
**Location:** Feature Engineering Spec, "FRED Data Integration" section  
**Severity:** P2 — Architectural blocker for Phase 2

⚠️ **SCOPE:**
Converting from:
- **Current:** Point-in-time lookups: `eventValue = query(seriesId, candle.eventTime)`
- **Proposed:** Indexed arrays: `eventValue = fredArrays[seriesId][candle.index]`

**This affects BOTH builders:**
1. 1h Builder: Requires array indexing refactor
2. 15m Builder: Depends on 1h builder change

**Breaking changes for consumers:**
- Symbol registry queries
- Forecast features
- BHG context snapshot computation
- Any code doing point-in-time FRED lookups

**Action:** **SPIKE THIS BEFORE PHASE 2 STARTS**
- Estimate: 3–5 days for design + implementation
- Impact: All feature engineering downstream depends on decision
- Don't start Phase 2 until this is locked

---

### P2 SPARSE FEATURE: Sahm Rule Null-Safety
**Location:** Feature Engineering Spec, "Economic Indicators" section  
**Severity:** P2 — Documentation + implementation guardrail

⚠️ **SPARSITY PROBLEM:**
Sahm Rule proxy lookback at 15m: `12 * 22 * 96 = 25,344 bars` = **6 months of history**

Early rows in 15m dataset will have **completely NULL** Sahm Rule value until 6 months of data accumulated.

**Current spec note:** Correctly acknowledged  
**Required action:** 
1. Document expected sparsity in dataset metadata
2. Choose mitigation:
   - **Option A:** Clip dataset start to first valid Sahm value
   - **Option B:** Use forward-fill (NaN → prior valid value)
   - **Option C:** Accept null; impute in training

**Action:** Decide which approach before Phase 2 implementation.

---

## ML RESEARCH REPORT ISSUES

### P1 LOOK-AHEAD BIAS: event_price_velocity_1h Mid-Bar Releases
**Location:** ML Research Report, "Tier 2 Features" section  
**Severity:** P1 — Model integrity risk

❌ **CURRENT SPEC:**
> "event_price_velocity_1h — lagged by 1 bar"

⚠️ **RISK:** If economic release happens mid-bar (e.g., 08:30 ET during a 1h bar):
- The **same bar's close** already contains the market reaction
- Should use **close of NEXT bar** for clean reaction measurement
- Current spec doesn't specify this guard

✅ **REQUIRED IMPLEMENTATION:**
```typescript
// For each release event
function computeEventVelocity(eventTime: Date, candles: CandleData[]): number | null {
  // Find which candle contains the event
  const eventCandle = candles.find(c => 
    c.time * 1000 <= eventTime.getTime() && 
    eventTime.getTime() < (c.time + 3600) * 1000
  )
  
  if (!eventCandle) return null
  
  // Get the NEXT candle's close (reaction is complete)
  const eventCandleIndex = candles.indexOf(eventCandle)
  const nextCandle = candles[eventCandleIndex + 1]
  
  if (!nextCandle) return null  // Can't measure reaction
  
  // Velocity = reaction from bar after event
  return nextCandle.close - eventCandle.close
}
```

**Action:** Add explicit mid-bar release guardrail to implementation before training.

---

### P1 MEASUREMENT: RealMLP/TabM Inference Latency
**Location:** ML Research Report, Phase 4 "Experimental Models"  
**Severity:** P1 — Live trading feasibility

⚠️ **ISSUE:**
Report notes: "30-50% slower inference than training time"
- Training is batch, offline, no latency constraint
- **Live trading requires low-latency inference**
- No measurement of actual inference time on Apple Silicon

**Required benchmarks before Phase 4 experiments:**
```
Model:             | Training Time | Inference/sample
CatBoost (baseline)| 45s           | 2-5ms           ← baseline
RealMLP            | 60s           | 8-15ms          ← expected
TabM (experimental)| 75s           | 12-20ms         ← expected
GBM                | 40s           | 3-8ms           ← control
```

**Action:** Benchmark inference latency per model on Apple Silicon before Phase 4. If RealMLP/TabM exceed 15ms, reconsider for live trading.

---

### Valid Notes ✅
- Mitra "borderline 5K" caveat is correctly applied
- Dual-timeframe architecture (15m for entry, aggregated for context) is sound
- AutoGluon 1.5 notes are accurate

---

## TRADE FEEDBACK SPEC ISSUES

### P1 CRITICAL GUARDRAIL: BHG Streak Timing
**Location:** Trade Feedback Spec, "BHG Feedback Features" section  
**Severity:** P1 — Look-ahead leakage

❌ **TIMING RISK:**
Feature: `bhg_consecutive_wins` / `bhg_consecutive_losses`

Current issue: Definition uses `goTime` (when setup fired).  
**Problem:** Setup **resolution** (SL/TP hit) can occur **hours after** `goTime`.

Example:
```
goTime = 09:30 ET (setup fires)
slHitTime = 13:15 ET (stop loss hit 3.75 hours later)

Current candle = 10:00 ET

If we include this setup's outcome at 10:00 ET candle,
we're using FUTURE information (SL won't hit for 3+ hours)
```

✅ **CORRECT GUARDRAIL (from spec):**
> "Only include fully-resolved setups whose completion timestamp is before the current candle timestamp"

**Implementation requirement:**
```typescript
// Completion = when outcome was actually determined
const completedAt = setup.tp1HitTime || setup.tp2HitTime || setup.slHitTime || null

if (!completedAt || completedAt >= currentCandle.timestamp) {
  // Setup not yet resolved; exclude from streak calculation
  return null
}

// Only then include in consecutive wins/losses count
```

**Action:** Implement explicit `completedAt = COALESCE(tp1HitTime, tp2HitTime, slHitTime)` check; verify all streak features use this.

---

### P2 FRED REVISION CYCLES: GDPC1 & BOPGSTB
**Location:** Trade Feedback Spec, "Data Quality" section  
**Severity:** P2 — Historical data integrity

⚠️ **REVISION LAG PROBLEM:**
Two series have significant revision cycles:

**GDPC1 (GDP):**
- Released as "Advance" estimate (first release)
- Revised as "Preliminary" ~1 month later
- Revised as "Final" ~2 months after initial
- Historical data back to 1990 can still be revised

**IMPCH (China Imports):**
- Released monthly, subject to revision for up to 3 months
- Common revisions: +/- 5–10% of initial value

**Current spec approach:** "Point-in-time lookup" ✅ **Correct**

**Implementation guard:**
```typescript
// When pulling FRED data, fetch the VINTAGE as-of the feature timestamp
// not the current "latest" value which includes future revisions

const fredVintage = await fetchFredVintage(
  seriesId: 'GDPC1',
  asOfDate: featureTimestamp,  // ← Use feature date, not today
  revisionState: 'latest_known_at_date'
)
```

**Action:** Document vintage retrieval explicitly in implementation; flag GDPC1/IMPCH as "revision-sensitive" in feature metadata.

---

### P2 CONTEXT SNAPSHOT: Not a Training Feature
**Location:** Trade Feedback Spec, "`contextSnapshot` field"  
**Severity:** P2 — Temptation to misuse

✅ **APPROACH IS CORRECT:**
Spec correctly says: "Good for exploratory analysis, NOT for training features"

⚠️ **ENFORCEMENT GUARD:**
Risk: Developers may later think "let me just use contextSnapshot as a feature"

**Policy to enforce:**
```typescript
// In build script validation
const FORBIDDEN_COLUMNS = ['contextSnapshot', 'rawPayload', 'metadata']

for (const feature of features) {
  if (FORBIDDEN_COLUMNS.includes(feature.name)) {
    throw new Error(
      `${feature.name} is debug/analysis only. ` +
      `Extract specific fields into canonical features instead.`
    )
  }
}
```

**Action:** Add validation check; document "analysis only" constraint in schema comments.

---

### P2 TRADING ECONOMICS API COVERAGE NOTE
**Location:** Trade Feedback Spec, "Data Sources"  
**Severity:** P2 — Expected variance

✅ **NOTE IS CORRECT:**
TE consensus differs from Bloomberg on lower-tier releases. This is acceptable for signal direction but watch magnitude.

Example: NFP surprise may vary ±20% depending on consensus source, but direction (bullish/bearish) is consistent.

**Action:** No code change needed; document expected variance in analysis notebooks.

---

## CROSS-DOCUMENT CONSISTENCY ISSUES

### P2 BLOCKER: Column Count Baseline Inconsistency
**Status:** RED 🔴  
**Severity:** P2 — Planning confusion

❌ **INCONSISTENCY ACROSS SPECS:**

| Document | Column Count | Starting Baseline | Notes |
|----------|--------------|-------------------|-------|
| Feature Eng Spec | ~150 total | 66 baseline | Includes all pending phases |
| ML Research Report | ~82 after Phase 1-2 | 77 baseline | Post-selection snapshot |
| Trade Feedback Spec | ~107–110 | Unknown | BHG features added |

**ROOT CAUSE:** Specs written at different times with different baseline column counts.

**IMPACT:**
- No single source of truth for "how many columns will this be"
- Implementation uncertainty about scope
- Resource planning (memory, training time) ambiguous

**ACTION REQUIRED:** Establish canonical column inventory
```markdown
## Canonical Column Inventory (Single Source of Truth)

### Baseline (Phase 0 — existing):
- 77 core columns (price, volume, technical, volatility, correlation)

### Phase 1 (FRED Economic) — adds 21 columns:
- Previous add: 20 columns (rates, inflation, labor, activity, yields, FX, commodities)
- Activity expansion: +1 column (IMPCH)
- Total after Phase 1: 98 columns

### Phase 2 (Momentum & Events) — adds 32 columns:
- Rolling momentum: +16 columns
- Event impact features: +10 columns
- BHG context: +6 columns
- Total after Phase 2: 130 columns

### Phase 3 (Cross-Asset) — adds 20 columns:
- Correlation universe: +15 columns
- Regime indicators: +5 columns
- Total after Phase 3: 150 columns

### Phase 4 (BHG Feedback) — adds ~15 columns:
- BHG feedback features: +15 columns
- Total after Phase 4: ~165 columns
```

**Action:** Kirk to create & distribute canonical inventory before implementation.

---

### P2 ISSUE: 15m Dataset Purpose Unclear Across Specs
**Status:** YELLOW ⚠️  
**Severity:** P2 — Dependency clarification

❌ **CONFLICTING DEFINITIONS:**

**ML Research Report:**
> "15m dataset: Entry-timing model for precise setup confirmation"

**Feature Engineering Spec:**
> "15m builder: Parallel full-feature dataset (same columns as 1h, indexed to 15m bars)"

**Trade Feedback Spec:**
> "[No explicit timeframe mentioned; assumes features feed wherever they're queried]"

**ARCHITECTURAL QUESTION:**
Do rolling features feed:
- **Option A:** 15m model only (BHG fires on 15m, makes sense)
- **Option B:** Both 1h + 15m models (redundant computation)
- **Option C:** 1h model only, with 15m aggregation (loses granularity)

**Current spec implies Option A is correct** — BHG setup fires on 15m, so rolling stats should feed 15m model.

**ACTION REQUIRED:** Explicit reconciliation
```markdown
## Timeframe Architecture (Explicit)

1. **15m Intraday Model** (for entry confirmation)
   - Trained on MktFuturesMes15m candles
   - All rolling features indexed to 15m bars
   - Input: 16-week 15m history (~96 bars/day)
   
2. **1h Broader Context Model** (optional, future)
   - Trained on aggregated 1h candles from 15m data
   - Lower-frequency rolling stats (longer lookback windows)
   - Input: 1-year 1h history

3. **Daily Cross-Asset Model** (Phase 3+, optional)
   - Trained on daily multi-asset returns
   - Economic/regime indicators only (no rolling price stats)
```

**Action:** Kirk to confirm which models actually needed; document timeframe for each rolling feature.

---

### P2 NOTE: SOX.c.0 News Signal Cross-Reference Risk
**Status:** LOW PROBABILITY  
**Severity:** P2 — Data quality edge case

⚠️ **RISK:**
If `news_signals` table has rows tagged with `tags: ['semiconductor', 'SOX']` expecting cross-reference against `crossAssetSymbols` (which includes `SOX.c.0`), those signals will be orphaned.

**Likelihood:** Low (but possible if news pipeline was pre-indexed with SOX tags)

**ACTION:** Quick scan before Phase 3
```sql
SELECT COUNT(*) 
FROM news_signals 
WHERE tags @> '["SOX"]' OR tags @> '["semiconductor"]'
```

If count > 0: Either drop SOX from news tags or replace SOX.c.0 with SMH proxy.

---

## PRIORITY MATRIX

### Phase Gates (Must Complete Before Each Phase)

| Priority | Issue | Blocker | Owner | Timeline |
|----------|-------|---------|-------|----------|
| **P0** | SOX.c.0: Replace with SMH or drop | Phase 3 | Kirk | **Before Phase 1** |
| **P0** | Prisma error type: Fix `PrismaClientConnectedError` → `PrismaClientInitializationError` | Audit | Kirk | **Before implementing audits** |
| **P1** | Activity series: Confirm 5 vs 6 count | Phase 1 scope | Kirk | **Before Phase 1 starts** |
| **P1** | Vectorize rolling helpers | Phase 2 performance | Dev | **Before Phase 2 starts** |
| **P1** | FRED point-in-time refactor: Architecture spike | Phase 2 blocker | Dev | **1-week spike, before Phase 2** |
| **P1** | event_price_velocity_1h: Add mid-bar release guards | Model integrity | Dev | **Impl guardrail in Phase 1** |
| **P1** | BHG streak timing: Use completedAt, not goTime | Feature correctness | Dev | **Impl guardrail in Phase 4** |
| **P1** | Accelerate timeout: Add batch pre-checks | Silent failure | Dev | **Before ingestion at scale** |
| **P2** | Canonical column inventory | Planning clarity | Kirk | **Before all phases start** |
| **P2** | 15m vs 1h model timeframe reconciliation | Design clarity | Kirk | **Before Phase 2 feature eng** |
| **P2** | RealMLP/TabM inference latency benchmark | Phase 4 feasibility | Dev | **Before Phase 4 experiments** |
| **P2** | 15m dataset memory benchmark | Phase 2 feasibility | Dev | **Before Phase 2 build script** |
| **P2** | FRED revision cycles: Document vintage logic | Data integrity | Dev | **Impl doc in Phase 1** |
| **P2** | contextSnapshot JSON enforcement | Guardrail | Dev | **Add validation in Phase 4** |
| **P2** | SOX news signal scan | Data quality | Dev | **Before Phase 3** |

---

## ACTION ITEMS BY PHASE

### Immediate (Before Any Development Starts)

- [ ] **Kirk:** Resolve SOX.c.0 (replace with SMH or drop)
- [ ] **Kirk:** Confirm Activity series count (5 or 6?)
- [ ] **Kirk:** Create canonical column inventory spreadsheet
- [ ] **Kirk:** Reconcile 15m vs 1h model timeframe architecture
- [ ] **Audit:** Update Recommendation #8 with correct Prisma error types
- [ ] **Audit:** Reframe Finding #5 (non-unique index gap)
- [ ] **Audit:** Clarify Rec #2 (pool config in connection string, not schema)

### Phase 1 Setup (Feature Engineering — Before Implementation)

- [ ] **Dev:** Design & implement vectorized rolling stat computation
- [ ] **Dev:** Spike FRED point-in-time → indexed-array refactor (3–5 days)
- [ ] **Dev:** Add mid-bar release guards to event_price_velocity implementation
- [ ] **Dev:** Design 15m vs 1h column allocation strategy
- [ ] **Dev:** Document Sahm Rule sparsity (choose null-handling approach)
- [ ] **Dev:** Add fast-path implementation for econIndicators lookups

### Phase 2 (Dataset Building)

- [ ] **Dev:** Benchmark 15m dataset memory & build time on Apple Silicon
- [ ] **Dev:** Implement Accelerate batch pre-checks (max size validation)
- [ ] **Dev:** Add transaction timeout monitoring (4.5s explicit timeout)
- [ ] **Dev:** Document FRED vintage retrieval for GDPC1/IMPCH series
- [ ] **Dev:** Implement streaming/chunking if memory exceeds 500 MB

### Phase 3 (Cross-Asset Features)

- [ ] **Dev:** Replace SOX.c.0 with SMH in `crossAssetSymbols` (or remove)
- [ ] **Dev:** Scan `news_signals` for orphaned SOX/semiconductor tags
- [ ] **Dev:** Update cross-asset feature registration (adjust baseline count)

### Phase 4 (BHG Feedback & Experimental Models)

- [ ] **Dev:** Implement explicit `completedAt` check in BHG streak features
- [ ] **Dev:** Benchmark RealMLP/TabM inference latency on Apple Silicon
- [ ] **Dev:** Add `contextSnapshot` validation (forbid as training feature)
- [ ] **Dev:** Test BHG setup resolution timing in outcome checker

---

## SIGN-OFF CHECKLIST

- [ ] Kirk reviewed & approved all P0 resolutions
- [ ] Kirk confirmed canonical column inventory
- [ ] Kirk decided 15m vs 1h model architecture
- [ ] Dev completed FRED refactor spike (or decided to defer)
- [ ] Audit corrections merged into recommendation docs
- [ ] All blocking issues resolved; implementation can begin

---

**Last updated:** 2026-02-27  
**Status:** ACTIVE — All issues tracked, no implementation until gate items cleared  
**Owner:** Kirk (approval); Dev team (execution)
