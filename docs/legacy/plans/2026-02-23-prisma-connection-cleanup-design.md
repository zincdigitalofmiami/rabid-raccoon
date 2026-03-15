# Prisma 7 Connection Cleanup — Corrected Design

**Date:** 2026-02-23
**Status:** Approved (v2 — corrected after forensic audit)
**Supersedes:** Original design was based on Prisma 5/6 patterns that don't apply to Prisma 7.

## What We Learned (Forensic Audit)

Prisma 7.4.0 has fundamentally different connection architecture:

1. **`url` and `directUrl` removed from `schema.prisma`** — Prisma 7 moved these to `prisma.config.ts`
2. **`PrismaClient` REQUIRES either `adapter` or `accelerateUrl`** — bare `new PrismaClient()` throws
3. **`prisma.config.ts` feeds CLI** (migrate, studio, introspect) — completely separate from runtime
4. **`@prisma/adapter-pg` IS needed** — it's the Prisma 7 way to do direct Postgres connections
5. **The dual-mode URL detection in `prisma.ts` is correct** — it's not "over-engineered", it's necessary

## What's Actually Broken

| Issue | Root Cause |
|-------|------------|
| `prisma migrate status` fails | No `prisma.config.ts` exists — CLI has no DB URL |
| `prisma studio` fails | Same — no `prisma.config.ts` |
| Accelerate unused in production | Vercel `DATABASE_URL` = `postgres://` (direct), not Accelerate |
| No caching support | `@prisma/extension-accelerate` not installed |
| 5 redundant Vercel vars | Auto-generated `rrdb_*` + unused `POSTGRES_URL`, `PRISMA_DATABASE_URL` |

## Solution

### 1. Create `prisma.config.ts` (NEW FILE — project root)

```typescript
import "dotenv/config"
import { defineConfig, env } from "prisma/config"

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
})
```

This file is ONLY used by the Prisma CLI. Runtime queries go through `src/lib/prisma.ts`.

### 2. `prisma/schema.prisma` — NO CHANGES

```prisma
generator client {
  provider   = "prisma-client-js"
  engineType = "binary"
}

datasource db {
  provider = "postgresql"
}
```

This is already correct for Prisma 7. No `url`, no `directUrl`.

### 3. Modify `src/lib/prisma.ts` — Add Accelerate extension

Changes:
- Add import: `@prisma/extension-accelerate`
- When Accelerate path: call `.$extends(withAccelerate())` on client
- Cast back to `PrismaClient` for type compat (verified: compiles clean)

The dual-mode URL detection STAYS. `@prisma/adapter-pg` STAYS.

### 4. Install `@prisma/extension-accelerate` — ALREADY DONE

Added to package.json during type verification.

### 5. Environment Variables — Target State

**Local `.env.local`:**
```
DATABASE_URL="prisma+postgres://..."  (existing — Accelerate)
DIRECT_URL="postgres://...@db.prisma.io:5432/postgres?sslmode=require"  (NEW)
```

**Vercel (all envs):**
```
DATABASE_URL="prisma+postgres://..."  (CHANGE from postgres:// to Accelerate)
DIRECT_URL="postgres://...@db.prisma.io:5432/postgres?sslmode=require"  (NEW)
```

**Remove from Vercel:** POSTGRES_URL, PRISMA_DATABASE_URL, rrdb_DATABASE_URL, rrdb_POSTGRES_URL, rrdb_PRISMA_DATABASE_URL

### 6. Update `.env.example` and `.env`

Document the two-URL pattern.

## What Does NOT Change

- `prisma/schema.prisma` — already correct
- `@prisma/adapter-pg` — needed for direct connections
- `pg` — needed by adapter-pg
- All 15 consumer files — untouched
- All 23 migrations — untouched
- Inngest functions — untouched

## Verification

1. `prisma validate` passes
2. `prisma generate` succeeds
3. `prisma migrate status` works (via DIRECT_URL in prisma.config.ts)
4. `npx tsc --noEmit` passes
5. `next build` succeeds
6. Vercel deploy works
7. App queries work with Accelerate
