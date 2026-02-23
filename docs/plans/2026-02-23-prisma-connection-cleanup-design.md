# Prisma Connection Cleanup — Design

**Date:** 2026-02-23
**Status:** Approved

## Problem

The Prisma database connection setup has several issues:

1. **URL mismatch:** Vercel production uses direct Postgres (`postgres://...@db.prisma.io`) but local dev uses Accelerate (`prisma+postgres://accelerate.prisma-data.net`). Different connection paths cause different behavior.
2. **No `directUrl` in schema:** `prisma migrate dev`, `prisma studio`, and `prisma db push` all go through Accelerate locally, which is unreliable for DDL operations.
3. **Redundant Vercel env vars:** 6 database env vars exist on Vercel (`DATABASE_URL`, `POSTGRES_URL`, `PRISMA_DATABASE_URL`, plus `rrdb_*` prefixed duplicates). Only 2 are needed.
4. **Over-engineered `prisma.ts`:** Dual-mode URL detection logic (`PrismaPg` adapter vs Accelerate) adds complexity. The schema's `url`/`directUrl` handles this natively.
5. **No connection limit:** Missing `connection_limit` parameter for serverless environments.
6. **Unused dependency:** `@prisma/adapter-pg` is imported but unnecessary when using schema-level `url`/`directUrl`.

## Solution

Align to Prisma's recommended Accelerate + direct connection pattern.

### 1. Schema (`prisma/schema.prisma`)

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")    // Accelerate (pooled, for app queries)
  directUrl = env("DIRECT_URL")      // Direct Postgres (for migrations, studio)
}
```

Generator block unchanged (`engineType = "binary"` is correct).

### 2. Vercel Environment Variables — Target State

**Keep/Set:**
- `DATABASE_URL` = Accelerate URL (`prisma+postgres://accelerate.prisma-data.net/?api_key=...`)
- `DIRECT_URL` = Direct Postgres (`postgres://...@db.prisma.io:5432/postgres?sslmode=require`)

**Remove (redundant):**
- `POSTGRES_URL`
- `PRISMA_DATABASE_URL`
- `rrdb_DATABASE_URL`
- `rrdb_POSTGRES_URL`
- `rrdb_PRISMA_DATABASE_URL`

### 3. Local Environment (`.env.local`)

```
DATABASE_URL="prisma+postgres://accelerate.prisma-data.net/?api_key=..."  (existing)
DIRECT_URL="postgres://...@db.prisma.io:5432/postgres?sslmode=require"    (new)
```

### 4. Prisma Client (`src/lib/prisma.ts`)

Remove `@prisma/adapter-pg` import and URL-sniffing logic. Simplify to standard singleton:

```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

export const prisma = globalForPrisma.prisma ?? (
  process.env.NODE_ENV !== 'production'
    ? (globalForPrisma.prisma = createPrismaClient())
    : createPrismaClient()
)
```

### 5. Remove `@prisma/adapter-pg` from `package.json`

No longer needed — schema-level `url`/`directUrl` handles connection routing.

### 6. Update `.env.example`

Document both URLs with comments explaining their purpose.

### 7. Update `.env`

Add comment referencing both vars.

## What This Does NOT Touch

- No model/table changes
- No new migrations
- No Inngest function changes
- No API route changes

## Verification

After implementation:
1. `prisma generate` succeeds
2. `prisma migrate dev --create-only` works locally (via DIRECT_URL)
3. `prisma studio` connects locally
4. App queries work in dev (`next dev`)
5. Vercel deploy succeeds with new env vars
6. No type errors, lint passes
