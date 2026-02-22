# CONVENTIONS.md — Rabid Raccoon Coding Standards

Read AGENTS.md first. This document details the specific coding standards and patterns for the project. If anything here conflicts with AGENTS.md, AGENTS.md wins.

## TypeScript

### General

- Strict mode always. No `any` unless absolutely unavoidable (and documented why).
- Prefer `const` over `let`. Never use `var`.
- Use explicit return types on exported functions.
- Use Prisma-generated types for database models — don't recreate them.
- Prefer early returns over deep nesting.
- No unused imports, variables, or parameters. The linter catches this — don't ignore it.

### Imports

```typescript
// Order: external → internal → types
import { PrismaClient } from '@prisma/client'
import { inngest } from '@/inngest/client'

import { getSymbolsByRole } from '@/lib/symbol-registry'
import { fetchCandlesForSymbol } from '@/lib/fetch-candles'

import type { IngestionSymbol } from '@/lib/symbol-registry/types'
```

### Error Handling

```typescript
// CORRECT — catch, log, and propagate with context
try {
  await prisma.mktFuturesMes1h.createMany({ data: candles, skipDuplicates: true })
} catch (err) {
  console.error(`[ingest-mes-1h] Failed to insert ${candles.length} candles:`, err)
  throw new Error(`MES 1h ingestion failed: ${err instanceof Error ? err.message : String(err)}`)
}

// WRONG — silent swallow
try {
  await prisma.mktFuturesMes1h.createMany({ data: candles, skipDuplicates: true })
} catch {
  // do nothing
}
```

### Logging

Use bracketed prefixes for traceability:

```typescript
console.log(`[ingest-mes-1h] Fetching candles since ${since.toISOString()}`)
console.log(`[ingest-mes-1h] Inserted ${result.count} rows`)
console.error(`[ingest-mes-1h] Failed: ${err.message}`)
```

## Prisma & Database

### Schema Conventions

```prisma
// Model: PascalCase
// Table map: snake_case
// Fields: camelCase
// All timestamps: Timestamptz(6) in UTC
// All dates: Date
// All prices: Decimal(18, 6)
// All econ values: Decimal(24, 8)

model ExampleTable {
  id            BigInt     @id @default(autoincrement())
  symbolCode    String     @db.VarChar(16)
  eventTime     DateTime   @db.Timestamptz(6)
  value         Decimal    @db.Decimal(18, 6)
  source        DataSource @default(DATABENTO)
  ingestedAt    DateTime   @default(now()) @db.Timestamptz(6)
  knowledgeTime DateTime   @default(now()) @db.Timestamptz(6)
  rowHash       String?    @db.VarChar(64)
  metadata      Json?

  @@unique([symbolCode, eventTime], map: "example_table_symbol_time_key")
  @@index([eventTime], map: "example_table_time_idx")
  @@map("example_table")
}
```

### Decimal Precision Rules

| Data Type | Precision | Example |
|-----------|-----------|---------|
| Prices (market) | `Decimal(18, 6)` | MES close, futures OHLCV |
| Econ values | `Decimal(24, 8)` | FRED series, inflation, yields |
| Ratios/scores | `Decimal(8, 6)` | Retracement ratio, correlation score |
| Percentages | `Decimal(10, 4)` | Surprise percentage |

### Query Patterns

```typescript
// CORRECT — idempotent upsert
await prisma.mktFuturesMes1h.createMany({
  data: candles,
  skipDuplicates: true,  // relies on unique constraint
})

// CORRECT — single-record upsert
await prisma.econCalendar.upsert({
  where: { eventDate_eventName: { eventDate, eventName } },
  update: { actual, forecast, previous },
  create: { eventDate, eventName, actual, forecast, previous, ... },
})

// WRONG — check-then-insert (race condition)
const exists = await prisma.mktFuturesMes1h.findFirst({ where: { eventTime } })
if (!exists) {
  await prisma.mktFuturesMes1h.create({ data: candle })
}
```

### Soft Deletes

We do not use soft deletes. Data in this system is either:

- **Current** — actively queried and maintained.
- **Dropped** — removed via migration with full audit trail in migration history.

If a future requirement needs soft delete, it will be designed explicitly with `deletedAt` column and scoped queries. Don't add it preemptively.

## Ingestion Scripts

### Structure

Every ingestion script follows this pattern:

```typescript
import { PrismaClient } from '@prisma/client'
import { getSymbolsByRole } from '@/lib/symbol-registry'

const prisma = new PrismaClient()

async function main() {
  const run = await prisma.ingestionRun.create({
    data: { job: 'ingest-example', status: 'RUNNING' },
  })

  try {
    // 1. Resolve symbols from registry
    const symbols = await getSymbolsByRole('INGESTION_ACTIVE')

    // 2. Fetch external data
    const data = await fetchFromSource(symbols)

    // 3. Transform and validate
    const rows = data.map(transform).filter(validate)

    // 4. Write with idempotent pattern
    const result = await prisma.exampleTable.createMany({
      data: rows,
      skipDuplicates: true,
    })

    // 5. Update run record
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        rowsProcessed: data.length,
        rowsInserted: result.count,
      },
    })

    console.log(`[ingest-example] Done: ${result.count}/${data.length} rows inserted`)
  } catch (err) {
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        details: { error: err instanceof Error ? err.message : String(err) },
      },
    })
    throw err
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error('[ingest-example] Fatal:', err)
  process.exit(1)
})
```

### MES Special Handling

MES is the primary instrument and gets special treatment:

- MES always uses dedicated tables (`mkt_futures_mes_*`), never the generic `mkt_futures_*` tables.
- MES branch logic (`if (symbolCode === 'MES')`) in ingestion scripts is acceptable — it's behavioral, routing data to the correct table.
- MES gets longer timeouts and more retry attempts than other symbols.
- MES ingestion failures should be treated as critical.

## Inngest Functions

### Structure

Every Inngest function is a thin wrapper that delegates to a shared library function:

```typescript
// src/inngest/functions/econ-rates.ts
import { inngest } from '@/inngest/client'
import { runIngestOneFredSeries } from '@/scripts/ingest-fred-complete'
import { getSymbolsByRole } from '@/lib/symbol-registry'

export const ingestEconRates = inngest.createFunction(
  { id: 'ingest-econ-rates', name: 'Ingest FRED Rates' },
  { cron: '0 7 * * 1-5' },  // Weekdays 7am UTC
  async ({ step }) => {
    const series = await getSymbolsByRole('ECON_RATES')
    // ... delegate to shared function
  },
)
```

### Rules

- One function per file.
- Function ID must be kebab-case and descriptive.
- Cron schedules must have a comment explaining the cadence in human terms.
- Never put business logic in the Inngest function — delegate to a shared library.
- Symbol lists come from the registry, never hardcoded in the function file.

## API Routes

### Structure

```typescript
// src/app/api/example/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  try {
    // 1. Parse and validate input
    const params = parseParams(req)

    // 2. Query database
    const data = await prisma.exampleTable.findMany({ ... })

    // 3. Transform for response
    const response = data.map(transform)

    return NextResponse.json({ ok: true, data: response })
  } catch (err) {
    console.error('[api/example] Error:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
```

### Rules

- Always return `{ ok: boolean, data?: ..., error?: string }` shape.
- Always catch and log errors — never let them propagate unhandled.
- Read-only routes should never write to the database.
- Symbol references should use `SYMBOL_KEYS` from the registry adapter (during migration) or query the registry directly (post-migration).

## Components (React / Dashboard)

### Structure

- One component per file.
- File name matches component name in PascalCase.
- Props interface defined and exported if non-trivial.
- Use TailwindCSS for styling — no CSS modules, no styled-components.

### Symbol Display Logic

Behavioral symbol references in components are acceptable:

```typescript
// ACCEPTABLE — behavioral logic for display
const INVERSE_SYMBOLS = new Set(['VX', 'DX', 'US10Y', 'ZN', 'ZB'])
const isInverse = INVERSE_SYMBOLS.has(symbol)
const color = isInverse
  ? (change > 0 ? 'red' : 'green')
  : (change > 0 ? 'green' : 'red')
```

These describe *how to display* a symbol, not *which symbols exist*. They don't need to move to the registry.

## Git & Commits

### Commit Messages

Format: `[domain] action: description`

```
[ingestion] add: symbol registry service module
[schema] migrate: add symbol_roles and symbol_role_members tables
[dashboard] fix: forecast panel inverse symbol display
[training] refactor: build-lean-dataset to use registry for cross-asset symbols
[governance] update: AGENTS.md with migration policy
```

### Rules

- Commit after each logical change, not one giant commit.
- Never commit `node_modules/`, `.env*`, or dataset files.
- Every commit should leave the project in a buildable state.
- Migration commits include both the Prisma schema change and the migration SQL.

## CI Guardrails

### Symbol Lint Rule

No symbol literal arrays outside the registry, seeds, or tests.

The lint/CI check should:

1. Scan `src/` and `scripts/` for patterns matching symbol array definitions.
2. Whitelist: `src/lib/symbol-registry/`, `src/lib/symbol-registry/snapshot.ts`, `prisma/seed.ts`, `**/*.test.ts`.
3. Fail the build if a new hardcoded symbol array is introduced outside the whitelist.

### Migration Drift Check

Before any deployment:

1. Run `prisma db pull` and diff against `schema.prisma`.
2. Fail if there are model/enum identity differences.
3. Warn (don't fail) on introspection normalization differences.

### Build Checks

Every PR must pass:

- `npx tsc --noEmit` (type check)
- `npx prisma generate` (schema generation)
- Lint rules (including symbol lint)

## Patterns to Avoid

| Don't Do This | Do This Instead |
|---------------|-----------------|
| `const SYMBOLS = ['MES', 'NQ', ...]` in a script | `getSymbolsByRole('CORRELATION_SET')` |
| `catch { /* nothing */ }` | `catch (err) { console.error(...); throw err }` |
| `any` type | Proper type from Prisma or explicit interface |
| One massive migration | One concern per migration |
| `if (!exists) create` | `upsert` or `createMany({ skipDuplicates })` |
| Magic numbers | Named constants with comments |
| `console.log('error')` | `console.error('[module] Description:', err)` |
| Modifying `symbols.ts` | Using the symbol registry |
| Creating a new agent instruction file | Reading AGENTS.md |

---

*Last updated: 2026-02-22*
*Maintained by: Kirk (architect) with Claude (governance)*
