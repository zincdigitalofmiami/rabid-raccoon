# Prisma 7 Connection Cleanup — Implementation Plan (v2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix Prisma CLI (migrate/studio), enable Accelerate everywhere with caching, and clean up redundant Vercel env vars.

**Architecture:** Prisma 7 splits connection config: `prisma.config.ts` feeds CLI tools (direct Postgres via DIRECT_URL), while `PrismaClient` constructor gets `adapter` or `accelerateUrl` at runtime. The schema datasource block has NO url fields — this is correct for Prisma 7. The existing dual-mode URL detection in `prisma.ts` is correct and stays.

**Tech Stack:** Prisma 7.4.0, @prisma/adapter-pg 7.4.0, @prisma/extension-accelerate 3.0.1, PostgreSQL, Prisma Accelerate, Vercel CLI

**Reference:** Corrected design at `docs/plans/2026-02-23-prisma-connection-cleanup-design.md`

**CRITICAL — what Prisma 7 changed from 5/6:**
- `url` and `directUrl` REMOVED from `schema.prisma` — use `prisma.config.ts` instead
- `PrismaClient()` with no args THROWS — must provide `adapter` or `accelerateUrl`
- `@prisma/adapter-pg` is REQUIRED for direct Postgres connections
- `@prisma/extension-accelerate` enables query caching via `cacheStrategy`

---

### Task 1: Create `prisma.config.ts`

**Files:**
- Create: `prisma.config.ts` (project root, next to package.json)

**Step 1: Create the file**

Create `prisma.config.ts` at the project root with this exact content:

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

**Why this works:**
- `dotenv/config` loads `.env.local` (which has DIRECT_URL after Task 2)
- `env("DIRECT_URL")` reads the direct Postgres connection string
- `datasource.url` is used ONLY by CLI commands (migrate, studio, introspect, db push)
- Runtime queries go through `src/lib/prisma.ts` — completely separate path

**Step 2: Verify schema still validates**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

**Step 3: Commit**

```bash
git add prisma.config.ts
git commit -m "fix(prisma): add prisma.config.ts for CLI database connection

Prisma 7 requires prisma.config.ts for CLI tools (migrate, studio,
introspect). Uses DIRECT_URL env var for direct Postgres connection."
```

---

### Task 2: Add DIRECT_URL to Local Environment

**Files:**
- Modify: `.env.local` (gitignored — no commit)

**Step 1: Pull direct Postgres URL from Vercel**

Run:
```bash
npx vercel env pull /tmp/rr-env-pull --environment=production 2>/dev/null
grep "^POSTGRES_URL=" /tmp/rr-env-pull
```

Expected: `POSTGRES_URL="postgres://...@db.prisma.io:5432/postgres?sslmode=require"`

Copy the value (everything inside the quotes).

**Step 2: Add DIRECT_URL to .env.local**

Add this line to the end of `.env.local` (paste the value from step 1):

```
# Direct Postgres for CLI (migrate, studio)
DIRECT_URL="postgres://...@db.prisma.io:5432/postgres?sslmode=require"
```

**Step 3: Clean up temp file**

Run: `rm /tmp/rr-env-pull`

**Step 4: Verify Prisma CLI now works**

Run: `npx prisma migrate status`
Expected: Lists all 23 migrations as applied. NO errors about "datasource.url property is required".

This is the critical verification — if this works, `prisma.config.ts` + `DIRECT_URL` is correctly wired.

**Step 5: Verify Studio connects**

Run: `npx prisma studio`
Expected: Opens browser at localhost:5555 with all tables visible. Ctrl+C to close.

**DO NOT COMMIT** — `.env.local` is gitignored.

---

### Task 3: Add Accelerate Extension to `prisma.ts`

**Files:**
- Modify: `src/lib/prisma.ts:1-35`

**Step 1: Read the current file to confirm starting state**

Run: `cat src/lib/prisma.ts`

Confirm it matches:
```typescript
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
// ... (45 lines total, dual-mode URL detection, Proxy wrapper)
```

**Step 2: Add the Accelerate extension import and usage**

Add import on line 3:
```typescript
import { withAccelerate } from '@prisma/extension-accelerate'
```

Replace lines 23-27 (the PrismaClient constructor block):

BEFORE:
```typescript
  const client = new PrismaClient({
    ...(adapter ? { adapter } : {}),
    ...(useAccelerateUrl ? { accelerateUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
```

AFTER:
```typescript
  const baseClient = new PrismaClient({
    ...(adapter ? { adapter } : {}),
    ...(useAccelerateUrl ? { accelerateUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

  const client = useAccelerateUrl
    ? (baseClient.$extends(withAccelerate()) as unknown as PrismaClient)
    : baseClient
```

**What this does:**
- When Accelerate URL detected: extends client with `withAccelerate()` for caching support
- When direct Postgres URL: uses base client with PrismaPg adapter (no extension needed)
- `as unknown as PrismaClient` cast is necessary because `$extends()` returns a wider type — verified this compiles clean during forensic audit
- All 15 consumer files continue to work — they only use standard Prisma methods

**Step 3: Verify the full file looks correct**

The complete file after edits should be:

```typescript
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { withAccelerate } from '@prisma/extension-accelerate'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
  prismaUrl?: string
}

function getPrismaClient(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured; Prisma client is unavailable')
  }

  if (globalForPrisma.prisma && globalForPrisma.prismaUrl === databaseUrl) {
    return globalForPrisma.prisma
  }

  const usePgAdapter = /^postgres(ql)?:\/\//i.test(databaseUrl)
  const useAccelerateUrl = /^prisma(\+postgres)?:\/\//i.test(databaseUrl)
  const adapter = usePgAdapter ? new PrismaPg({ connectionString: databaseUrl }) : undefined

  const baseClient = new PrismaClient({
    ...(adapter ? { adapter } : {}),
    ...(useAccelerateUrl ? { accelerateUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

  const client = useAccelerateUrl
    ? (baseClient.$extends(withAccelerate()) as unknown as PrismaClient)
    : baseClient

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
    globalForPrisma.prismaUrl = databaseUrl
  }

  return client
}

const prismaProxy = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrismaClient()
    const value = Reflect.get(client, prop, receiver)
    return typeof value === 'function' ? value.bind(client) : value
  },
})

export const prisma: PrismaClient = prismaProxy
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 5: Verify Prisma generate still works**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client (v7.4.0)`

**Step 6: Commit**

```bash
git add src/lib/prisma.ts
git commit -m "feat(prisma): add Accelerate caching extension

Adds withAccelerate() when DATABASE_URL is an Accelerate URL.
Enables per-query cacheStrategy support for edge caching.
Direct Postgres path unchanged (PrismaPg adapter, no extension)."
```

---

### Task 4: Update `.env.example` and `.env`

**Files:**
- Modify: `.env.example:1-2`
- Modify: `.env` (entire file)

**Step 1: Update `.env.example`**

Replace lines 1-2:

```
# Database (Postgres — set via .env)
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/rabid_raccoon?schema=public
```

With:

```
# Database (Prisma Postgres)
# Runtime queries — Accelerate proxy (pooled + edge-cached)
DATABASE_URL=prisma+postgres://accelerate.prisma-data.net/?api_key=YOUR_ACCELERATE_KEY
# CLI operations (migrate, studio) — direct Postgres
DIRECT_URL=postgres://USER:PASSWORD@db.prisma.io:5432/postgres?sslmode=require
```

**Step 2: Update `.env`**

Replace entire contents with:

```
# See .env.local for actual DATABASE_URL and DIRECT_URL (Prisma Postgres)
# DATABASE_URL = Accelerate proxy (pooled + cached, for app runtime queries)
# DIRECT_URL   = Direct Postgres (for prisma migrate, studio, introspect)
# This file is committed to git — do NOT put secrets here.
```

**Step 3: Commit**

```bash
git add .env.example .env
git commit -m "docs: update env templates for Prisma 7 two-URL pattern

DATABASE_URL = Accelerate (runtime queries, pooled + cached)
DIRECT_URL = Direct Postgres (CLI: migrate, studio, introspect)"
```

---

### Task 5: Set Vercel Environment Variables

**Context:** Vercel currently has `DATABASE_URL = postgres://` (direct). We need to change it to Accelerate, add `DIRECT_URL`, and remove 5 redundant vars.

**Step 1: Get the Accelerate URL**

Run: `grep "^DATABASE_URL=" .env.local`

Copy the value — this is the Accelerate URL (`prisma+postgres://accelerate.prisma-data.net/?api_key=...`).

**Step 2: Get the direct Postgres URL**

Run: `npx vercel env pull /tmp/rr-env-pull --environment=production 2>/dev/null && grep "^POSTGRES_URL=" /tmp/rr-env-pull`

Copy the value — this is the direct URL (`postgres://...@db.prisma.io:5432/postgres?sslmode=require`).

**Step 3: Remove existing DATABASE_URL from all envs**

```bash
npx vercel env rm DATABASE_URL production -y
npx vercel env rm DATABASE_URL preview -y
npx vercel env rm DATABASE_URL development -y
```

**Step 4: Set DATABASE_URL to Accelerate URL on all envs**

```bash
printf '%s' 'ACCELERATE_URL_HERE' | npx vercel env add DATABASE_URL production
printf '%s' 'ACCELERATE_URL_HERE' | npx vercel env add DATABASE_URL preview
printf '%s' 'ACCELERATE_URL_HERE' | npx vercel env add DATABASE_URL development
```

Replace `ACCELERATE_URL_HERE` with the actual value from Step 1 (no quotes).

**Step 5: Add DIRECT_URL on all envs**

```bash
printf '%s' 'DIRECT_PG_URL_HERE' | npx vercel env add DIRECT_URL production
printf '%s' 'DIRECT_PG_URL_HERE' | npx vercel env add DIRECT_URL preview
printf '%s' 'DIRECT_PG_URL_HERE' | npx vercel env add DIRECT_URL development
```

Replace `DIRECT_PG_URL_HERE` with the actual value from Step 2 (no quotes).

**Step 6: Remove redundant vars**

Check which envs each var exists on, then remove:

```bash
npx vercel env rm POSTGRES_URL production -y
npx vercel env rm POSTGRES_URL preview -y
npx vercel env rm POSTGRES_URL development -y
npx vercel env rm PRISMA_DATABASE_URL production -y
npx vercel env rm PRISMA_DATABASE_URL preview -y
npx vercel env rm PRISMA_DATABASE_URL development -y
npx vercel env rm rrdb_DATABASE_URL production -y
npx vercel env rm rrdb_DATABASE_URL preview -y
npx vercel env rm rrdb_DATABASE_URL development -y
npx vercel env rm rrdb_POSTGRES_URL production -y
npx vercel env rm rrdb_POSTGRES_URL preview -y
npx vercel env rm rrdb_POSTGRES_URL development -y
npx vercel env rm rrdb_PRISMA_DATABASE_URL production -y
npx vercel env rm rrdb_PRISMA_DATABASE_URL preview -y
npx vercel env rm rrdb_PRISMA_DATABASE_URL development -y
```

Some of these may not exist on all envs — that's fine, `vercel env rm` will just say "not found".

**Step 7: Verify final state**

Run: `npx vercel env ls | grep -iE "DATABASE|POSTGRES|PRISMA_DATA|DIRECT"`

Expected: ONLY `DATABASE_URL` and `DIRECT_URL` remain, on production/preview/development.

**Step 8: Clean up temp file**

Run: `rm /tmp/rr-env-pull`

---

### Task 6: Deploy and Verify

**Step 1: Deploy to Vercel**

Run: `npx vercel --prod`
Expected: Build succeeds. Deployment URL returned.

**Step 2: Verify app database connectivity**

Run: `curl -s https://rabid-raccoon.vercel.app/api/market-data/mes | head -c 200`
Expected: JSON response with candle data. NOT an error page.

**Step 3: Verify Prisma CLI works locally**

Run: `npx prisma migrate status`
Expected: All 23 migrations listed as applied.

**Step 4: Force Inngest re-sync**

Run: `curl -X PUT "https://rabid-raccoon.vercel.app/api/inngest" -H "Content-Type: application/json" -d '{}'`
Expected: `{"message":"Successfully registered","modified":true}`

**Step 5: Verify TypeScript + lint clean**

Run: `npx tsc --noEmit && npx next lint`
Expected: No errors from either command.

---

## Rollback Plan

If production breaks after Vercel deploy:

1. **Restore direct Postgres as DATABASE_URL:**
```bash
npx vercel env rm DATABASE_URL production -y
printf '%s' 'DIRECT_PG_URL' | npx vercel env add DATABASE_URL production
npx vercel --prod
```

2. **Revert code changes:**
```bash
git log --oneline -5  # find commits to revert
git revert HEAD~N..HEAD --no-commit
git commit -m "revert: roll back prisma connection cleanup"
npx vercel --prod
```
