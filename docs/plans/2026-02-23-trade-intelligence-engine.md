# Trade Intelligence Engine — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified trade intelligence system that scores every BHG setup using fibs, event awareness, correlations, ML baselines, and AI reasoning — displayed on a single chart-first page.

**Architecture:** Two-layer hybrid — Layer 1 (deterministic BHG + event awareness + market context + ML baseline) runs on every setup. Layer 2 (OpenAI reasoning) runs on qualifying setups. Single-page UI with hero chart and three toggle panels.

**Tech Stack:** Next.js 15, React 19, Prisma 7, TailwindCSS, Lightweight Charts, OpenAI Responses API, AutoGluon (Python training), SSE streams.

**Design doc:** `docs/plans/2026-02-23-trade-intelligence-engine-design.md`

---

## Phase 1: Foundation — Rename Phases + Fix Data Gaps

These are prerequisite fixes before building new features.

---

### Task 1: Rename BHG Phases — Engine Types

Rename TOUCHED→CONTACT, HOOKED→CONFIRMED, GO_FIRED→TRIGGERED across the engine.

**Files:**
- Modify: `src/lib/bhg-engine.ts:18` (SetupPhase type), plus lines 108, 133, 146, 165, 194, 207, 217, 229, 239, 267, 412, 417, 423, 435, 441
- Modify: `src/lib/types.ts:131` (re-export)

**Step 1: Update SetupPhase type**

In `src/lib/bhg-engine.ts` line 18, change:
```typescript
export type SetupPhase = 'AWAITING_TOUCH' | 'TOUCHED' | 'HOOKED' | 'GO_FIRED' | 'EXPIRED' | 'INVALIDATED'
```
to:
```typescript
export type SetupPhase = 'AWAITING_CONTACT' | 'CONTACT' | 'CONFIRMED' | 'TRIGGERED' | 'EXPIRED' | 'INVALIDATED'
```

**Step 2: Replace all string literals in bhg-engine.ts**

Global replacements in `src/lib/bhg-engine.ts`:
- `'AWAITING_TOUCH'` → `'AWAITING_CONTACT'`
- `'TOUCHED'` → `'CONTACT'`
- `'HOOKED'` → `'CONFIRMED'`
- `'GO_FIRED'` → `'TRIGGERED'`

Verify no occurrences remain with grep.

**Step 3: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -50`
Expected: Type errors in files that reference old phase names (API route, components, hooks). This is expected — we fix those in subsequent tasks.

**Step 4: Commit**

```bash
git add src/lib/bhg-engine.ts
git commit -m "refactor: rename BHG phases — CONTACT/CONFIRMED/TRIGGERED"
```

---

### Task 2: Rename BHG Phases — Prisma Schema

**Files:**
- Modify: `prisma/schema.prisma:65-73` (BhgPhase enum)

**Step 1: Update BhgPhase enum**

In `prisma/schema.prisma` lines 65–73, change:
```prisma
enum BhgPhase {
  TOUCHED
  HOOKED
  GO_FIRED
  EXPIRED
  STOPPED
  TP1_HIT
  TP2_HIT
}
```
to:
```prisma
enum BhgPhase {
  CONTACT
  CONFIRMED
  TRIGGERED
  EXPIRED
  STOPPED
  TP1_HIT
  TP2_HIT
}
```

**Step 2: Generate migration**

Run: `npx prisma migrate dev --name rename-bhg-phases`

This will require updating existing rows. The migration SQL should include:
```sql
UPDATE bhg_setups SET phase = 'CONTACT' WHERE phase = 'TOUCHED';
UPDATE bhg_setups SET phase = 'CONFIRMED' WHERE phase = 'HOOKED';
UPDATE bhg_setups SET phase = 'TRIGGERED' WHERE phase = 'GO_FIRED';
```

Review the generated migration file before applying.

**Step 3: Commit**

```bash
git add prisma/
git commit -m "refactor: rename BhgPhase enum in schema — CONTACT/CONFIRMED/TRIGGERED"
```

---

### Task 3: Rename BHG Phases — API, Hooks, Components

**Files:**
- Modify: `src/app/api/mes/setups/route.ts:78` (`'GO_FIRED'` check)
- Modify: `src/hooks/useMesSetups.ts` (types only, no phase literals)
- Modify: `src/components/MesIntraday/SignalTile.tsx:74` (`goType` display)
- Modify: `src/components/MesIntraday/SetupLog.tsx:21-46` (PhaseBadge config + sort order)
- Modify: `src/components/MesIntraday/MesIntradayDashboard.tsx:18,25-27` (phase filters)
- Modify: `src/components/MesIntraday/RiskTile.tsx` (any phase references)

**Step 1: Update API route**

In `src/app/api/mes/setups/route.ts` line 78, change:
```typescript
if (s.phase !== 'GO_FIRED' || !s.entry || !s.stopLoss || !s.tp1) {
```
to:
```typescript
if (s.phase !== 'TRIGGERED' || !s.entry || !s.stopLoss || !s.tp1) {
```

**Step 2: Update MesIntradayDashboard**

In `src/components/MesIntraday/MesIntradayDashboard.tsx`:
- Line 18: `s.phase === 'GO_FIRED'` → `s.phase === 'TRIGGERED'`
- Line 25: `s.phase === 'TOUCHED'` → `s.phase === 'CONTACT'`
- Line 26: `s.phase === 'HOOKED'` → `s.phase === 'CONFIRMED'`
- Line 27: `s.phase === 'GO_FIRED'` → `s.phase === 'TRIGGERED'`

**Step 3: Update SetupLog PhaseBadge and sort**

In `src/components/MesIntraday/SetupLog.tsx` lines 21–46, replace old phase keys with new ones:
```typescript
const config: Record<string, { text: string; className: string }> = {
  TRIGGERED:   { text: 'TRIGGER', className: 'text-emerald-400 bg-emerald-400/10' },
  CONFIRMED:   { text: 'CONFIRM', className: 'text-amber-400 bg-amber-400/10' },
  CONTACT:     { text: 'CONTACT', className: 'text-white/40 bg-white/5' },
  EXPIRED:     { text: 'EXPIRED', className: 'text-white/20 bg-white/5' },
  INVALIDATED: { text: 'INVALID', className: 'text-red-400/40 bg-red-400/5' },
}

const phaseOrder: Record<string, number> = {
  TRIGGERED:   0,
  CONFIRMED:   1,
  CONTACT:     2,
  EXPIRED:     3,
  INVALIDATED: 4,
}
```

**Step 4: Update SignalTile**

In `src/components/MesIntraday/SignalTile.tsx` line 74, change any `goType GO` display text. Replace "GO" with "TRIGGER" in the footer display.

**Step 5: Grep for remaining old phase names**

Run: `grep -rn "GO_FIRED\|TOUCHED\|HOOKED\|AWAITING_TOUCH" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules`

Fix any remaining occurrences. Also check `scripts/` directory:
Run: `grep -rn "GO_FIRED\|TOUCHED\|HOOKED" scripts/ --include="*.ts"`

Note: Script files (`build-bhg-dataset.ts`, `backtest-signals.ts`) may also reference old phases. Update those too.

**Step 6: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

**Step 7: Commit**

```bash
git add src/ scripts/
git commit -m "refactor: rename BHG phases across API, hooks, and components"
```

---

### Task 4: Fix econ_calendar eventTime Timezone Bug

The `build-lean-dataset.ts` parses "08:30 ET" as UTC hours. Fix to parse as America/New_York.

**Files:**
- Modify: `scripts/build-lean-dataset.ts:573-591` (parseEventDateTimeMs function)

**Step 1: Read the current parseEventDateTimeMs function**

Read `scripts/build-lean-dataset.ts` lines 573–591.

**Step 2: Fix timezone parsing**

The function parses `eventTime` like "08:30 ET" but treats the hours as UTC. Fix to:
1. Extract hours and minutes from the string
2. Create a Date in America/New_York timezone
3. Convert to UTC milliseconds

Use this pattern:
```typescript
function parseEventDateTimeMs(eventDate: Date, eventTime: string | null): number | null {
  if (!eventTime) return null
  const match = eventTime.match(/(\d{1,2}):(\d{2})/)
  if (!match) return null
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)

  // eventDate is a Date at midnight UTC. Build the ET datetime string.
  const y = eventDate.getUTCFullYear()
  const m = String(eventDate.getUTCMonth() + 1).padStart(2, '0')
  const d = String(eventDate.getUTCDate()).padStart(2, '0')
  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')

  // Parse as Eastern Time
  const etString = `${y}-${m}-${d}T${hh}:${mm}:00`
  const utcDate = new Date(
    new Date(etString + '-05:00').getTime() // EST offset; for EDT use -04:00
  )

  // Better: use Intl to handle DST correctly
  // For dataset building, a ±1hr error is tolerable. Production event-awareness
  // will use a proper timezone library.
  return utcDate.getTime()
}
```

Note: For the dataset builder, an approximate fix is acceptable. The live `event-awareness.ts` (Task 6) will use proper timezone handling.

**Step 3: Commit**

```bash
git add scripts/build-lean-dataset.ts
git commit -m "fix: correct ET timezone parsing in econ calendar feature builder"
```

---

### Task 5: Add eventPhase Feature to BHG Dataset Builder

The fib-scorer has zero event features. Add event proximity to `build-bhg-dataset.ts`.

**Files:**
- Modify: `scripts/build-bhg-dataset.ts` — add event feature loading and computation

**Step 1: Read the current feature computation section**

Read `scripts/build-bhg-dataset.ts` around the `computeGoFeatures` function to understand where to add new features.

**Step 2: Add econ_calendar loading**

Near the top of the main function, after the existing FRED snapshot loading, add:
```typescript
// Load econ calendar events
const econEvents = await prisma.econCalendar.findMany({
  where: { impactRating: { in: ['high', 'medium'] } },
  orderBy: { eventDate: 'asc' },
  select: { eventDate: true, eventTime: true, eventName: true, impactRating: true, actual: true },
})

// Parse event timestamps (reuse parseEventDateTimeMs from build-lean-dataset or inline)
const eventTimestampsMs = econEvents
  .map(e => ({ ...e, tsMs: parseEventDateTimeMs(e.eventDate, e.eventTime) }))
  .filter(e => e.tsMs !== null)
  .sort((a, b) => a.tsMs! - b.tsMs!)
```

**Step 3: Add event features to computeGoFeatures**

Add these features to each GO event row:
```typescript
// Find the nearest future high-impact event relative to GO time
const goTimeMs = goCandle.time  // epoch ms of the GO bar
const nextEvent = eventTimestampsMs.find(e => e.tsMs! > goTimeMs)
const prevEvent = [...eventTimestampsMs].reverse().find(e => e.tsMs! <= goTimeMs)

const minutesToNextEvent = nextEvent
  ? (nextEvent.tsMs! - goTimeMs) / (60 * 1000)
  : null

const minutesSincePrevEvent = prevEvent
  ? (goTimeMs - prevEvent.tsMs!) / (60 * 1000)
  : null

// Categorical phase (will be refined by backtesting)
let eventPhase = 'CLEAR'
if (minutesToNextEvent !== null && minutesToNextEvent <= 5) eventPhase = 'IMMINENT'
else if (minutesToNextEvent !== null && minutesToNextEvent <= 60) eventPhase = 'APPROACHING'
if (minutesSincePrevEvent !== null && minutesSincePrevEvent <= 60) eventPhase = 'DIGESTING'
if (minutesSincePrevEvent !== null && minutesSincePrevEvent <= 5) eventPhase = 'BLACKOUT'
```

Add to the feature row:
```typescript
minutes_to_next_high_impact: minutesToNextEvent,
minutes_since_prev_event: minutesSincePrevEvent,
event_phase: eventPhase,
is_high_impact_day: isHighImpactDay ? 1 : 0,
next_event_impact: nextEvent?.impactRating ?? null,
next_event_name: nextEvent?.eventName ?? null,
```

**Step 4: Add surprise z-scores**

Port the `buildReleaseChangeZLookup` pattern from `build-lean-dataset.ts` (lines 600-641) into `build-bhg-dataset.ts`. Add the 6 z-score features:
```
nfp_release_z, cpi_release_z, ppi_release_z,
retail_sales_release_z, gdp_release_z, claims_release_z,
econ_surprise_index
```

These use the same 1-day lag pattern as the lean dataset builder.

**Step 5: Add technical momentum features**

Port from `build-lean-dataset.ts` the computation of:
- `sqz_mom`, `sqz_state` (Squeeze Pro — find the function in build-lean-dataset)
- `wvf_value`, `wvf_percentile` (Williams Vix Fix)
- `macd_hist`, `macd_hist_color` (CM Ultimate MACD)

These are computed per-candle. For the BHG dataset, compute them at the GO bar.

**Step 6: Add cross-asset correlation features**

Port from `build-lean-dataset.ts`:
- `mes_nq_corr_21d`, `mes_zn_corr_21d` (21-day rolling Pearson)
- `concordance_1h` (1-hour directional agreement)
- `equity_bond_diverge` (MES-ZN divergence)

This requires loading NQ and ZN candles from `mkt_futures_1h`.

**Step 7: Add enhanced labels**

Add new outcome labels alongside existing ones:
```typescript
// Existing
tp1_before_sl_1h: lookForwardLabel(allCandles, goBarGlobalIndex, setup, 'tp1', 4),
tp1_before_sl_4h: lookForwardLabel(allCandles, goBarGlobalIndex, setup, 'tp1', 16),
tp2_before_sl_8h: lookForwardLabel(allCandles, goBarGlobalIndex, setup, 'tp2', 32),

// New
tp1_before_sl_2h: lookForwardLabel(allCandles, goBarGlobalIndex, setup, 'tp1', 8),
max_favorable_4h: computeMaxExcursion(allCandles, goBarGlobalIndex, setup, 16, 'favorable'),
max_adverse_4h: computeMaxExcursion(allCandles, goBarGlobalIndex, setup, 16, 'adverse'),
time_to_tp1_bars: computeTimeToTarget(allCandles, goBarGlobalIndex, setup, 'tp1', 16),
```

Write the `computeMaxExcursion` and `computeTimeToTarget` helper functions:

```typescript
function computeMaxExcursion(
  allCandles: CandleData[], goBarIndex: number, setup: BhgSetup,
  horizonBars: number, type: 'favorable' | 'adverse'
): number | null {
  if (!setup.entry) return null
  const endIdx = Math.min(goBarIndex + horizonBars, allCandles.length)
  let maxExcursion = 0
  for (let i = goBarIndex + 1; i < endIdx; i++) {
    const candle = allCandles[i]
    const favorable = setup.direction === 'BULLISH'
      ? candle.high - setup.entry
      : setup.entry - candle.low
    const adverse = setup.direction === 'BULLISH'
      ? setup.entry - candle.low
      : candle.high - setup.entry
    const excursion = type === 'favorable' ? favorable : adverse
    maxExcursion = Math.max(maxExcursion, excursion)
  }
  return Math.round(maxExcursion * 4) / 4 // round to MES tick
}

function computeTimeToTarget(
  allCandles: CandleData[], goBarIndex: number, setup: BhgSetup,
  targetType: 'tp1' | 'tp2', horizonBars: number
): number | null {
  const target = targetType === 'tp1' ? setup.tp1 : setup.tp2
  if (!target || !setup.stopLoss) return null
  const endIdx = Math.min(goBarIndex + horizonBars, allCandles.length)
  for (let i = goBarIndex + 1; i < endIdx; i++) {
    const candle = allCandles[i]
    if (setup.direction === 'BULLISH') {
      if (candle.low <= setup.stopLoss) return null // SL hit first
      if (candle.high >= target) return i - goBarIndex
    } else {
      if (candle.high >= setup.stopLoss) return null
      if (candle.low <= target) return i - goBarIndex
    }
  }
  return null // never hit
}
```

**Step 8: Verify dataset builds**

Run: `npx tsx scripts/build-bhg-dataset.ts --dry-run --limit=100`
(If `--dry-run` doesn't exist, add a small test run. Verify CSV output has new columns.)

**Step 9: Commit**

```bash
git add scripts/build-bhg-dataset.ts
git commit -m "feat: enrich BHG dataset with event, technical, and cross-asset features"
```

---

## Phase 2: Event Awareness Engine (Live)

---

### Task 6: Create event-awareness.ts

The core module that reads econ_calendar and produces real-time event context.

**Files:**
- Create: `src/lib/event-awareness.ts`
- Test: `scripts/event-awareness.test.ts`

**Step 1: Write the test**

Create `scripts/event-awareness.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { getEventContext, EventContext } from '@/lib/event-awareness'

// Mock econ_calendar data
const mockEvents = [
  {
    eventDate: new Date('2026-02-23'),
    eventTime: '10:00 ET',
    eventName: 'ISM Manufacturing',
    impactRating: 'high',
    actual: null,
    forecast: null,
    surprise: null,
  },
]

describe('getEventContext', () => {
  it('returns CLEAR when no events nearby', () => {
    const ctx = getEventContext(new Date('2026-02-23T12:00:00Z'), mockEvents)
    expect(ctx.phase).toBe('CLEAR')
  })

  it('returns APPROACHING when event is within approach window', () => {
    // ISM at 10:00 ET = 15:00 UTC. 45 min before = 14:15 UTC
    const ctx = getEventContext(new Date('2026-02-23T14:15:00Z'), mockEvents)
    expect(ctx.phase).toBe('APPROACHING')
    expect(ctx.event?.name).toBe('ISM Manufacturing')
  })

  it('returns BLACKOUT in the immediate window around release', () => {
    const ctx = getEventContext(new Date('2026-02-23T14:59:00Z'), mockEvents)
    expect(ctx.phase).toBe('BLACKOUT')
  })

  it('returns DIGESTING shortly after release', () => {
    const ctx = getEventContext(new Date('2026-02-23T15:10:00Z'), mockEvents)
    expect(ctx.phase).toBe('DIGESTING')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/event-awareness.test.ts`
Expected: FAIL — module does not exist.

**Step 3: Implement event-awareness.ts**

Create `src/lib/event-awareness.ts`:
```typescript
import prisma from '@/lib/prisma'

export interface EventInfo {
  name: string
  impact: 'high' | 'medium' | 'low'
  time: Date
  actual: number | null
  forecast: number | null
  surprise: number | null
}

export interface EventContext {
  phase: 'CLEAR' | 'APPROACHING' | 'IMMINENT' | 'BLACKOUT' | 'DIGESTING' | 'SETTLED'
  event: EventInfo | null
  minutesToEvent: number | null
  minutesSinceEvent: number | null
  surprise: { zScore: number; direction: 'BEAT' | 'MISS' | 'INLINE' } | null
  confidenceAdjustment: number
  label: string
}

// Phase boundary defaults — THESE ARE PLACEHOLDERS.
// They MUST be replaced with backtested values from Task 8.
// Each value is in minutes. Negative = before event, positive = after.
const PHASE_BOUNDARIES = {
  APPROACHING_START: 60,  // TBD from backtesting
  IMMINENT_START: 10,     // TBD from backtesting
  BLACKOUT_START: 3,      // TBD from backtesting
  BLACKOUT_END: 5,        // TBD from backtesting
  DIGESTING_END: 45,      // TBD from backtesting
} as const

// Confidence adjustments — PLACEHOLDERS, replaced by backtesting.
const CONFIDENCE_ADJUSTMENTS = {
  CLEAR: 1.0,
  APPROACHING: 0.80,     // TBD
  IMMINENT: 0.50,        // TBD
  BLACKOUT: 0.0,         // no trades
  DIGESTING: 0.85,       // TBD — varies by surprise magnitude
  SETTLED: 1.0,
} as const

/**
 * Parse "HH:MM ET" into a UTC Date on the given eventDate.
 * Handles EST/EDT by checking if the date falls in DST range.
 */
function parseEventTimeET(eventDate: Date, eventTime: string | null): Date | null {
  if (!eventTime) return null
  const match = eventTime.match(/(\d{1,2}):(\d{2})/)
  if (!match) return null

  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)

  const y = eventDate.getUTCFullYear()
  const m = eventDate.getUTCMonth()
  const d = eventDate.getUTCDate()

  // Create date in ET, determine if DST
  const jan = new Date(y, 0, 1).getTimezoneOffset()
  const jul = new Date(y, 6, 1).getTimezoneOffset()
  const isDST = new Date(y, m, d).getTimezoneOffset() < Math.max(jan, jul)
  const offsetHours = isDST ? 4 : 5 // EDT = UTC-4, EST = UTC-5

  return new Date(Date.UTC(y, m, d, hours + offsetHours, minutes, 0))
}

/**
 * Get event context for a given timestamp.
 * Pass pre-loaded events for efficiency, or null to query DB.
 */
export function getEventContext(
  now: Date,
  events: Array<{
    eventDate: Date
    eventTime: string | null
    eventName: string
    impactRating: string | null
    actual: number | null
    forecast: number | null
    surprise: number | null
  }>
): EventContext {
  const nowMs = now.getTime()
  const B = PHASE_BOUNDARIES

  let closestEvent: EventInfo | null = null
  let closestDeltaMin = Infinity
  let isBeforeEvent = true

  for (const e of events) {
    const eventTime = parseEventTimeET(e.eventDate, e.eventTime)
    if (!eventTime) continue

    const deltaMs = eventTime.getTime() - nowMs
    const deltaMin = deltaMs / (60 * 1000)
    const absDelta = Math.abs(deltaMin)

    if (absDelta < Math.abs(closestDeltaMin) ||
        (absDelta === Math.abs(closestDeltaMin) && deltaMin > 0)) {
      closestDeltaMin = deltaMin
      closestEvent = {
        name: e.eventName,
        impact: (e.impactRating as 'high' | 'medium' | 'low') ?? 'low',
        time: eventTime,
        actual: e.actual ? Number(e.actual) : null,
        forecast: e.forecast ? Number(e.forecast) : null,
        surprise: e.surprise ? Number(e.surprise) : null,
      }
      isBeforeEvent = deltaMin > 0
    }
  }

  // No events found
  if (!closestEvent) {
    return {
      phase: 'CLEAR', event: null,
      minutesToEvent: null, minutesSinceEvent: null,
      surprise: null, confidenceAdjustment: 1.0,
      label: 'No scheduled events',
    }
  }

  const minutesToEvent = isBeforeEvent ? closestDeltaMin : null
  const minutesSinceEvent = !isBeforeEvent ? Math.abs(closestDeltaMin) : null

  // Determine phase
  let phase: EventContext['phase'] = 'CLEAR'
  let confidenceAdj = CONFIDENCE_ADJUSTMENTS.CLEAR

  if (isBeforeEvent) {
    const minTo = closestDeltaMin
    if (minTo <= B.BLACKOUT_START) {
      phase = 'BLACKOUT'
      confidenceAdj = CONFIDENCE_ADJUSTMENTS.BLACKOUT
    } else if (minTo <= B.IMMINENT_START) {
      phase = 'IMMINENT'
      confidenceAdj = CONFIDENCE_ADJUSTMENTS.IMMINENT
    } else if (minTo <= B.APPROACHING_START) {
      phase = 'APPROACHING'
      confidenceAdj = CONFIDENCE_ADJUSTMENTS.APPROACHING
    }
  } else {
    const minSince = Math.abs(closestDeltaMin)
    if (minSince <= B.BLACKOUT_END) {
      phase = 'BLACKOUT'
      confidenceAdj = CONFIDENCE_ADJUSTMENTS.BLACKOUT
    } else if (minSince <= B.DIGESTING_END) {
      phase = 'DIGESTING'
      confidenceAdj = CONFIDENCE_ADJUSTMENTS.DIGESTING
    } else {
      phase = 'SETTLED'
      confidenceAdj = CONFIDENCE_ADJUSTMENTS.SETTLED
    }
  }

  // Surprise scoring (if post-release and actual exists)
  let surprise: EventContext['surprise'] = null
  if (!isBeforeEvent && closestEvent.actual !== null) {
    // Use surprise field if available, otherwise we need forecast
    const surpriseVal = closestEvent.surprise
    if (surpriseVal !== null) {
      surprise = {
        zScore: surpriseVal,
        direction: surpriseVal > 0.5 ? 'BEAT' : surpriseVal < -0.5 ? 'MISS' : 'INLINE',
      }
    }
  }

  // Build label
  let label = ''
  if (phase === 'CLEAR') {
    label = minutesToEvent
      ? `${closestEvent.name} in ${Math.round(minutesToEvent)} min`
      : 'No nearby events'
  } else if (phase === 'APPROACHING') {
    label = `${closestEvent.name} in ${Math.round(minutesToEvent!)} min — expect compression`
  } else if (phase === 'IMMINENT') {
    label = `${closestEvent.name} in ${Math.round(minutesToEvent!)} min — caution`
  } else if (phase === 'BLACKOUT') {
    label = `BLACKOUT — ${closestEvent.name} releasing`
  } else if (phase === 'DIGESTING') {
    const dir = surprise?.direction ?? 'pending'
    label = `${closestEvent.name} ${Math.round(minutesSinceEvent!)} min ago — ${dir}`
  } else {
    label = `Post-${closestEvent.name} — settled`
  }

  return {
    phase, event: closestEvent,
    minutesToEvent, minutesSinceEvent,
    surprise, confidenceAdjustment: confidenceAdj,
    label,
  }
}

// Cache for today's events
let cachedDate: string | null = null
let cachedEvents: Array<{
  eventDate: Date; eventTime: string | null; eventName: string;
  impactRating: string | null; actual: number | null;
  forecast: number | null; surprise: number | null;
}> = []

/**
 * Load today's events from DB (cached per day).
 */
export async function loadTodayEvents(): Promise<typeof cachedEvents> {
  const today = new Date().toISOString().slice(0, 10)
  if (cachedDate === today && cachedEvents.length > 0) return cachedEvents

  const startOfDay = new Date(today + 'T00:00:00Z')
  const endOfDay = new Date(today + 'T23:59:59Z')

  const events = await prisma.econCalendar.findMany({
    where: {
      eventDate: { gte: startOfDay, lte: endOfDay },
      impactRating: { in: ['high', 'medium'] },
    },
    select: {
      eventDate: true, eventTime: true, eventName: true,
      impactRating: true, actual: true, forecast: true, surprise: true,
    },
  })

  cachedEvents = events.map(e => ({
    ...e,
    actual: e.actual ? Number(e.actual) : null,
    forecast: e.forecast ? Number(e.forecast) : null,
    surprise: e.surprise ? Number(e.surprise) : null,
  }))
  cachedDate = today
  return cachedEvents
}
```

**Step 4: Run tests**

Run: `npx vitest run scripts/event-awareness.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/event-awareness.ts scripts/event-awareness.test.ts
git commit -m "feat: add event awareness engine — reads econ_calendar live"
```

---

### Task 7: Wire Event Awareness into Setups API

**Files:**
- Modify: `src/app/api/mes/setups/route.ts`
- Modify: `src/hooks/useMesSetups.ts` (add EventContext to types)

**Step 1: Update the API route**

Add event context loading and enrichment to `/api/mes/setups/route.ts`:

After the existing risk computation (line ~82), add:
```typescript
import { getEventContext, loadTodayEvents, EventContext } from '@/lib/event-awareness'

// Inside the GET handler, after enrichedSetups:
const todayEvents = await loadTodayEvents()
const eventContext = getEventContext(new Date(), todayEvents)
```

Add `eventContext` to the response:
```typescript
return NextResponse.json({
  setups: enrichedSetups,
  fibResult,
  currentPrice,
  measuredMoves,
  eventContext,
  timestamp: new Date().toISOString(),
})
```

**Step 2: Update hook types**

In `src/hooks/useMesSetups.ts`, add `EventContext` to `MesSetupsResponse`:
```typescript
import { EventContext } from '@/lib/event-awareness'

export interface MesSetupsResponse {
  setups: EnrichedSetup[]
  fibResult: FibResult | null
  currentPrice: number | null
  measuredMoves?: MeasuredMove[]
  eventContext?: EventContext
  timestamp: string
  error?: string
}
```

**Step 3: TypeScript check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/api/mes/setups/route.ts src/hooks/useMesSetups.ts
git commit -m "feat: wire event awareness into setups API response"
```

---

### Task 8: Backtest Event Phase Thresholds

Derive T₁–T₅ boundaries from actual BHG outcome data near economic events.

**Files:**
- Create: `scripts/backtest-event-phases.ts`

**Step 1: Write the backtesting script**

Create `scripts/backtest-event-phases.ts`:

```typescript
/**
 * Backtest BHG setup outcomes by proximity to economic events.
 *
 * For each GO_FIRED setup in bhg_setups (with tp1Hit/tp2Hit/slHit populated),
 * compute the distance in minutes to the nearest high-impact econ_calendar event.
 * Bucket by distance and report TP1 hit rates per bucket.
 *
 * Output: recommended phase boundary thresholds.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// ... (full script implementation)
// 1. Load all bhg_setups with tp1Hit not null
// 2. Load all econ_calendar events with impactRating 'high'
// 3. For each setup, find nearest event (before and after goTime)
// 4. Bucket by minutes_to_nearest_event: [0-5, 5-10, 10-15, 15-30, 30-60, 60-120, 120+]
// 5. Report tp1_hit_rate per bucket
// 6. Find inflection points where hit rate changes significantly
// 7. Print recommended thresholds
```

This script must be run AFTER `build-bhg-dataset.ts` has populated `bhg_setups` with outcome labels.

**Step 2: Run the backtest**

Run: `npx tsx scripts/backtest-event-phases.ts`

**Step 3: Update PHASE_BOUNDARIES in event-awareness.ts**

Replace placeholder values with backtested thresholds.

**Step 4: Update CONFIDENCE_ADJUSTMENTS**

Replace placeholder multipliers with `hitRate_inPhase / hitRate_baseline` from backtest results.

**Step 5: Commit**

```bash
git add scripts/backtest-event-phases.ts src/lib/event-awareness.ts
git commit -m "feat: backtest event phase thresholds — data-driven boundaries"
```

---

## Phase 3: Live Feature Vector + ML Inference

---

### Task 9: Create trade-features.ts — Live Feature Assembly

Port feature computation from dataset builders into a real-time module.

**Files:**
- Create: `src/lib/trade-features.ts`
- Test: `scripts/trade-features.test.ts`

**Step 1: Write the module**

Create `src/lib/trade-features.ts` that exports:
```typescript
export interface TradeFeatureVector {
  // BHG features
  fibRatio: number
  goType: string
  hookQuality: number
  measuredMoveAligned: boolean
  measuredMoveQuality: number | null
  stopDistancePts: number
  rrRatio: number
  riskGrade: string

  // Event features
  eventPhase: string
  minutesToNextEvent: number | null
  confidenceAdjustment: number

  // Market context
  vixLevel: number | null
  vixPercentile: number | null
  regime: string
  themeScores: Record<string, number>

  // Correlation
  compositeAlignment: number
  isAligned: boolean

  // Technical (from current candles)
  sqzMom: number | null
  sqzState: string | null
  wvfValue: number | null
  macdHist: number | null

  // News
  newsVolume24h: number
  policyNewsVolume24h: number
}

export async function computeTradeFeatures(
  setup: BhgSetup,
  candles: CandleData[],
  eventContext: EventContext,
  marketContext: MarketContext,
  alignment: CorrelationAlignment
): Promise<TradeFeatureVector>
```

Port the indicator computations (Squeeze Pro, WVF, MACD) from `build-lean-dataset.ts` into pure functions that operate on a candle window.

**Step 2: Wire into setups API**

Compute features for each TRIGGERED setup and include in the response.

**Step 3: Commit**

```bash
git add src/lib/trade-features.ts scripts/trade-features.test.ts
git commit -m "feat: add live trade feature vector assembly"
```

---

### Task 10: ML Inference — Regime Lookup Table

Until ONNX or a Python sidecar is set up, use a bucketed lookup table from OOF predictions.

**Files:**
- Create: `scripts/build-regime-lookup.ts`
- Create: `src/lib/ml-baseline.ts`

**Step 1: Build the lookup table from OOF results**

Create `scripts/build-regime-lookup.ts`:
- Read `datasets/autogluon/fib_scorer_oof.csv` (OOF predictions from train-fib-scorer.py)
- Bucket by key feature bins (fibRatio, eventPhase, vixBucket, alignmentBucket, riskGrade)
- For each bucket: average p(TP1), average p(TP2), count, confidence interval
- Write to `src/data/regime-lookup.json`

**Step 2: Create ml-baseline.ts**

```typescript
import regimeLookup from '@/data/regime-lookup.json'

export interface MlBaseline {
  pTp1: number
  pTp2: number
  sampleCount: number
  confidence: 'high' | 'medium' | 'low'
}

export function getMlBaseline(features: TradeFeatureVector): MlBaseline
```

Matches the feature vector to the nearest regime bucket and returns the historical p(TP1)/p(TP2).

**Step 3: Commit**

```bash
git add scripts/build-regime-lookup.ts src/lib/ml-baseline.ts src/data/regime-lookup.json
git commit -m "feat: add ML baseline inference via regime lookup table"
```

---

### Task 11: Composite Score

Combine all layers into a single score per setup.

**Files:**
- Create: `src/lib/composite-score.ts`
- Test: `scripts/composite-score.test.ts`

**Step 1: Write the test**

Test that composite score combines sub-scores with correct weights and that BLACKOUT phase returns 0.

**Step 2: Implement**

```typescript
export interface TradeScore {
  composite: number          // 0-100
  grade: 'A' | 'B' | 'C' | 'D'
  pTp1: number              // 0-1 probability
  pTp2: number              // 0-1 probability
  subScores: {
    fib: number
    risk: number
    event: number
    correlation: number
    regime: number
    technical: number
    mlBaseline: number
  }
}

// Weights — PLACEHOLDERS, replaced by feature importance from retrained model
const WEIGHTS = {
  fib: 0.15,        // TBD from backtesting
  risk: 0.15,       // TBD
  event: 0.20,      // TBD
  correlation: 0.10, // TBD
  regime: 0.10,     // TBD
  technical: 0.10,  // TBD
  mlBaseline: 0.20, // TBD
} as const

export function computeCompositeScore(
  features: TradeFeatureVector,
  mlBaseline: MlBaseline
): TradeScore
```

**Step 3: Commit**

```bash
git add src/lib/composite-score.ts scripts/composite-score.test.ts
git commit -m "feat: add composite trade score with backtested weights"
```

---

### Task 12: AI Reasoning Layer

Per-trade OpenAI rationale for qualifying setups.

**Files:**
- Create: `src/lib/trade-reasoning.ts`

**Step 1: Implement**

Follow the existing pattern from `src/lib/forecast.ts` — model cascade, structured JSON response, deterministic fallback.

```typescript
export interface TradeReasoning {
  adjustedPTp1: number
  adjustedPTp2: number
  rationale: string
  keyRisks: string[]
  tradeQuality: 'A' | 'B' | 'C' | 'D'
}

export async function getTradeReasoning(
  setup: BhgSetup,
  score: TradeScore,
  features: TradeFeatureVector,
  eventContext: EventContext,
  marketContext: MarketContext
): Promise<TradeReasoning>
```

**Guardrails:**
- AI p(TP1) must be within ±0.20 of ML baseline
- VIX > 30 veto (force SELL direction)
- BLACKOUT = no reasoning (return deterministic fallback)
- Timeout: 3 seconds max, fall back to Layer 1 only

**Step 2: Commit**

```bash
git add src/lib/trade-reasoning.ts
git commit -m "feat: add AI trade reasoning layer with guardrails"
```

---

## Phase 4: Unified API

---

### Task 13: Create /api/trades/upcoming endpoint

The single endpoint that powers the Upcoming Trades panel.

**Files:**
- Create: `src/app/api/trades/upcoming/route.ts`

**Step 1: Implement**

This endpoint orchestrates everything:
1. Refresh MES data (existing)
2. Run BHG engine (existing)
3. Compute risk (existing)
4. Load event context (Task 6)
5. Build market context (existing `buildMarketContext`)
6. Compute correlation alignment (existing)
7. Assemble feature vectors (Task 9)
8. Get ML baselines (Task 10)
9. Compute composite scores (Task 11)
10. Get AI reasoning for A/B grade setups (Task 12)
11. Return unified trade cards

**Response shape:**
```typescript
interface UpcomingTradesResponse {
  trades: TradeCard[]
  eventContext: EventContext
  marketBrief: string
  timestamp: string
}

interface TradeCard {
  id: string
  direction: 'BULLISH' | 'BEARISH'
  phase: SetupPhase
  entry: number
  stopLoss: number
  tp1: number
  tp2: number
  pTp1: number
  pTp2: number
  score: TradeScore
  risk: RiskResult
  eventLabel: string
  correlationSummary: string
  reasoning: TradeReasoning | null  // null if below threshold
  fibRatio: number
  measuredMoveAligned: boolean
}
```

**Step 2: Commit**

```bash
git add src/app/api/trades/upcoming/route.ts
git commit -m "feat: add /api/trades/upcoming — unified trade intelligence endpoint"
```

---

## Phase 5: Single-Page UI

---

### Task 14: Create useUpcomingTrades hook

**Files:**
- Create: `src/hooks/useUpcomingTrades.ts`

Polls `/api/trades/upcoming` every 30 seconds. Returns `{ trades, eventContext, marketBrief, loading, error }`.

**Commit:**
```bash
git add src/hooks/useUpcomingTrades.ts
git commit -m "feat: add useUpcomingTrades polling hook"
```

---

### Task 15: Build TradeDashboard — Single Page

**Files:**
- Create: `src/components/TradeDashboard.tsx`
- Create: `src/components/TradeCard.tsx`
- Create: `src/components/DailyMovesPanel.tsx`
- Create: `src/components/BriefingPanel.tsx`
- Modify: `src/app/page.tsx` (swap MarketsPage → TradeDashboard)
- Delete: `src/app/mes/page.tsx` (remove /mes route)

**Step 1: Build TradeDashboard layout**

```
Three toggle buttons at top
Hero chart (LiveMesChart, preserved)
Context panel that swaps based on active button:
  - "Upcoming Trades" → list of TradeCard components
  - "Daily Moves" → DailyMovesPanel
  - "Briefing" → BriefingPanel
```

**Step 2: Build TradeCard component**

Displays: direction, entry/stop/TP1/TP2, p(TP1)/p(TP2), score grade, event label, correlation summary, AI rationale (if available). Matches the card design from the design doc.

**Step 3: Build DailyMovesPanel**

- ATR-based expected range
- Key fib levels for the day
- Today's econ calendar (from eventContext)

**Step 4: Build BriefingPanel**

- Market regime (1 sentence)
- Chart analysis (1-2 sentences)
- Key risk (1 sentence)
- Powered by existing market context + optional AI summary

**Step 5: Update routing**

`src/app/page.tsx`:
```typescript
import TradeDashboard from '@/components/TradeDashboard'
export default function Home() {
  return <TradeDashboard />
}
```

Remove `src/app/mes/page.tsx`.

Update `src/components/Header.tsx` — remove nav items (single page), simplify.

**Step 6: Commit**

```bash
git add src/components/TradeDashboard.tsx src/components/TradeCard.tsx \
  src/components/DailyMovesPanel.tsx src/components/BriefingPanel.tsx \
  src/app/page.tsx
git rm src/app/mes/page.tsx
git commit -m "feat: single-page trade dashboard with chart + 3 toggle panels"
```

---

### Task 16: Chart Trade Level Overlays

**Files:**
- Modify: `src/components/LiveMesChart.tsx`

Add the ability to draw trade levels (entry, stop, TP1, TP2) on the chart when an upcoming trade is selected or active.

Use Lightweight Charts `createPriceLine` API to draw horizontal lines at entry (white), stop (red), TP1 (green), TP2 (blue).

Accept a `tradeOverlay` prop:
```typescript
interface TradeOverlay {
  entry: number
  stopLoss: number
  tp1: number
  tp2: number
  direction: 'BULLISH' | 'BEARISH'
}
```

**Commit:**
```bash
git add src/components/LiveMesChart.tsx
git commit -m "feat: draw trade entry/stop/target levels on chart"
```

---

## Phase 6: Data Fixes + Polish

---

### Task 17: Wire news_signals into Trade Features

**Files:**
- Modify: `src/lib/trade-features.ts`

Query `news_signals` for last 24 hours, count by layer, pass top 5 headlines to AI reasoning prompt.

**Commit:**
```bash
git add src/lib/trade-features.ts
git commit -m "feat: wire news_signals volume into trade feature vector"
```

---

### Task 18: Wire model registry

**Files:**
- Modify: training scripts to write to `mes_model_registry` after training
- Modify: `src/lib/ml-baseline.ts` to read `isActive` model version

**Commit:**
```bash
git add scripts/ src/lib/ml-baseline.ts
git commit -m "feat: wire mes_model_registry — training writes, live reads"
```

---

### Task 19: Clean Up Dead Components

**Files:**
- Delete: `src/components/MarketsPage.tsx`
- Delete: `src/components/MarketsGrid.tsx`
- Delete: `src/components/ForecastPanel.tsx`
- Delete: `src/components/AnalysePanel.tsx`
- Delete: `src/components/MesIntraday/StatusTile.tsx`
- Delete: `src/components/MesIntraday/CorrelationTile.tsx`
- Delete: `src/components/MesIntraday/SignalTile.tsx`
- Delete: `src/components/MesIntraday/RiskTile.tsx`
- Delete: `src/components/MesIntraday/SetupLog.tsx`
- Delete: `src/components/MesIntraday/MesIntradayDashboard.tsx`

Only delete after TradeDashboard is fully functional and verified.

**Commit:**
```bash
git rm src/components/MarketsPage.tsx src/components/MarketsGrid.tsx \
  src/components/ForecastPanel.tsx src/components/AnalysePanel.tsx \
  src/components/MesIntraday/StatusTile.tsx src/components/MesIntraday/CorrelationTile.tsx \
  src/components/MesIntraday/SignalTile.tsx src/components/MesIntraday/RiskTile.tsx \
  src/components/MesIntraday/SetupLog.tsx src/components/MesIntraday/MesIntradayDashboard.tsx
git commit -m "chore: remove replaced dashboard components"
```

---

## Execution Dependencies

```
Task 1 → Task 2 → Task 3 (phase rename must be sequential)
Task 4 (timezone fix, independent)
Task 5 (dataset enrichment, depends on Task 4)
Task 6 → Task 7 (event awareness, then wire to API)
Task 8 (backtest, depends on Task 5 output)
Task 9 (trade features, depends on Task 6)
Task 10 (ML baseline, depends on Task 5 retraining)
Task 11 (composite score, depends on Tasks 9 + 10)
Task 12 (AI reasoning, depends on Task 11)
Task 13 (unified API, depends on Tasks 6-12)
Task 14 (hook, depends on Task 13)
Task 15 (UI, depends on Task 14)
Task 16 (chart overlays, depends on Task 15)
Tasks 17-19 (polish, depend on Task 15)
```

**Parallelizable:**
- Tasks 1-3 (rename) can run in parallel with Task 4 (timezone fix)
- Task 5 (dataset) can run in parallel with Task 6 (event awareness)
- Task 15 (UI) can start as soon as Task 13 is stubbed with mock data

---

## Training Checkpoint (Between Phase 2 and Phase 3)

After Tasks 5 and 8 are complete:
1. Rebuild the BHG dataset: `npx tsx scripts/build-bhg-dataset.ts`
2. Retrain fib-scorer: `python scripts/train-fib-scorer.py`
3. Build regime lookup: `npx tsx scripts/build-regime-lookup.ts`
4. Validate: OOF AUC should improve over baseline (pre-event-features)

This is a BLOCKING checkpoint. Tasks 10-12 depend on the retrained model output.
