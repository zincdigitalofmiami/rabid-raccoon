# Prisma Connection Cleanup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the Prisma connection setup so migrations/studio use a direct Postgres URL, runtime queries use Accelerate, and redundant env vars and code are removed.

**Architecture:** Add `url` + `directUrl` to the Prisma schema datasource block. Simplify `src/lib/prisma.ts` by removing the manual `@prisma/adapter-pg` dual-mode logic — Prisma Client handles Accelerate routing natively when the schema has an Accelerate `url`. Clean up Vercel env vars to exactly 2 database vars.

**Tech Stack:** Prisma 7.4, PostgreSQL, Prisma Accelerate, Vercel CLI (`npx vercel`), Next.js

**Reference:** Design doc at `docs/plans/2026-02-23-prisma-connection-cleanup-design.md`

---

### Task 1: Update Prisma Schema Datasource

**Files:**
- Modify: `prisma/schema.prisma:6-8`

**Step 1: Edit the datasource block**

Replace lines 6-8 in `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
}
```

With:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

**Step 2: Verify schema is valid**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid`

**Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "fix(prisma): add url and directUrl to datasource block"
```

---

### Task 2: Add DIRECT_URL to Local Environment

**Files:**
- Modify: `.env.local`

**Step 1: Get the direct Postgres URL from Vercel**

Run: `npx vercel env pull /tmp/rr-env-pull --environment=production 2>/dev/null && grep "^POSTGRES_URL=" /tmp/rr-env-pull`

This gives you the direct connection string (format: `postgres://...@db.prisma.io:5432/postgres?sslmode=require`).

**Step 2: Add DIRECT_URL to .env.local**

Add this line to `.env.local` (use the exact value from step 1):

```
DIRECT_URL="postgres://USER:PASS@db.prisma.io:5432/postgres?sslmode=require"
```

**Step 3: Clean up temp file**

Run: `rm /tmp/rr-env-pull`

**Step 4: Verify Prisma can connect via direct URL**

Run: `npx prisma migrate status`
Expected: Shows migration history without errors. This confirms `DIRECT_URL` works for CLI operations.

**DO NOT COMMIT** — `.env.local` is gitignored.

---

### Task 3: Simplify `src/lib/prisma.ts`

**Files:**
- Modify: `src/lib/prisma.ts`

**Step 1: Replace the entire file**

Replace the contents of `src/lib/prisma.ts` with:

```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  (process.env.NODE_ENV !== 'production'
    ? (globalForPrisma.prisma = createPrismaClient())
    : createPrismaClient())
```

What changed:
- Removed `import { PrismaPg } from '@prisma/adapter-pg'`
- Removed URL-sniffing regex logic (`usePgAdapter`, `useAccelerateUrl`)
- Removed `Proxy` wrapper (unnecessary indirection)
- Removed `prismaUrl` tracking (no longer needed without dual-mode)
- Kept singleton pattern for dev hot-reload safety
- Kept configurable logging (warn in dev, error-only in prod)

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add src/lib/prisma.ts
git commit -m "fix(prisma): simplify client — remove adapter-pg dual-mode logic"
```

---

### Task 4: Remove `@prisma/adapter-pg` Dependency

**Files:**
- Modify: `package.json`

**Step 1: Confirm no other files import adapter-pg**

Run: `grep -r "adapter-pg\|PrismaPg" src/ scripts/ --include="*.ts" --include="*.tsx"`
Expected: No matches (we already removed it from `prisma.ts` in Task 3).

**Step 2: Uninstall the package**

Run: `npm uninstall @prisma/adapter-pg`
Expected: Removes from `package.json` dependencies and `package-lock.json`.

**Step 3: Regenerate Prisma Client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`

**Step 4: Verify build**

Run: `npx next build`
Expected: Build succeeds without errors.

**Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove @prisma/adapter-pg — no longer needed with schema directUrl"
```

---

### Task 5: Update `.env.example` and `.env`

**Files:**
- Modify: `.env.example`
- Modify: `.env`

**Step 1: Update `.env.example`**

Replace lines 1-2 of `.env.example`:

```
# Database (Postgres — set via .env)
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/rabid_raccoon?schema=public
```

With:

```
# Database (Prisma Postgres)
# Runtime queries go through Accelerate (pooled + edge-cached)
DATABASE_URL=prisma+postgres://accelerate.prisma-data.net/?api_key=YOUR_ACCELERATE_KEY
# Direct connection for migrations, studio, introspection
DIRECT_URL=postgres://USER:PASSWORD@db.prisma.io:5432/postgres?sslmode=require
```

**Step 2: Update `.env`**

Replace the full contents of `.env` with:

```
# See .env.local for actual DATABASE_URL and DIRECT_URL (Prisma Postgres)
# DATABASE_URL = Accelerate proxy (pooled, for app runtime)
# DIRECT_URL   = Direct Postgres (for migrations, studio, CLI)
# This file is committed to git — do NOT put secrets here.
```

**Step 3: Commit**

```bash
git add .env.example .env
git commit -m "docs: update env templates with DATABASE_URL + DIRECT_URL pattern"
```

---

### Task 6: Set Vercel Environment Variables

**Context:** Vercel currently has 6+ database env vars. We need exactly 2: `DATABASE_URL` (Accelerate) and `DIRECT_URL` (direct Postgres). The Accelerate URL is in `.env.local`. The direct Postgres URL is currently stored as `POSTGRES_URL` on Vercel.

**Step 1: Get the two URLs we need**

Get the Accelerate URL (from `.env.local`):
Run: `grep "^DATABASE_URL=" .env.local | sed 's/DATABASE_URL=//'`

Get the direct Postgres URL (from Vercel):
Run: `npx vercel env pull /tmp/rr-env-pull --environment=production 2>/dev/null && grep "^POSTGRES_URL=" /tmp/rr-env-pull | sed 's/POSTGRES_URL=//'`

**Step 2: Set DATABASE_URL on Vercel to the Accelerate URL**

For each environment (production, preview, development), set `DATABASE_URL` to the Accelerate URL from Step 1.

Run for each environment:
```bash
echo "ACCELERATE_URL_VALUE" | npx vercel env add DATABASE_URL production
echo "ACCELERATE_URL_VALUE" | npx vercel env add DATABASE_URL preview
echo "ACCELERATE_URL_VALUE" | npx vercel env add DATABASE_URL development
```

Note: If Vercel says the var already exists, remove it first with `npx vercel env rm DATABASE_URL production -y`.

**Step 3: Add DIRECT_URL on Vercel**

```bash
echo "DIRECT_POSTGRES_URL_VALUE" | npx vercel env add DIRECT_URL production
echo "DIRECT_POSTGRES_URL_VALUE" | npx vercel env add DIRECT_URL preview
echo "DIRECT_POSTGRES_URL_VALUE" | npx vercel env add DIRECT_URL development
```

**Step 4: Remove redundant vars**

```bash
npx vercel env rm POSTGRES_URL production -y
npx vercel env rm POSTGRES_URL preview -y
npx vercel env rm POSTGRES_URL development -y
npx vercel env rm PRISMA_DATABASE_URL production -y
npx vercel env rm PRISMA_DATABASE_URL preview -y
npx vercel env rm PRISMA_DATABASE_URL development -y
npx vercel env rm rrdb_DATABASE_URL production -y
npx vercel env rm rrdb_POSTGRES_URL production -y
npx vercel env rm rrdb_PRISMA_DATABASE_URL production -y
```

Run for all environments where each var exists (check `npx vercel env ls` output).

**Step 5: Verify final state**

Run: `npx vercel env ls | grep -E "DATABASE_URL|DIRECT_URL|POSTGRES_URL|PRISMA_DATABASE"`
Expected: Only `DATABASE_URL` and `DIRECT_URL` remain (across production/preview/development).

**Step 6: Clean up temp file**

Run: `rm /tmp/rr-env-pull`

---

### Task 7: Deploy and Verify

**Step 1: Deploy to Vercel**

Run: `npx vercel --prod`
Expected: Build succeeds, deployment URL returned.

**Step 2: Verify the app works**

Hit a known API route to confirm database connectivity:
Run: `curl -s https://rabid-raccoon.vercel.app/api/market-data/mes | head -c 200`
Expected: JSON response with market data (not an error).

**Step 3: Verify Prisma CLI works locally**

Run: `npx prisma migrate status`
Expected: Shows all 23 migrations as applied.

Run: `npx prisma studio`
Expected: Opens browser with Prisma Studio connected to the database.

**Step 4: Force Inngest re-sync**

Run: `curl -X PUT "https://rabid-raccoon.vercel.app/api/inngest" -H "Content-Type: application/json" -d '{}'`
Expected: `{"message":"Successfully registered","modified":true}`

---

## Rollback Plan

If anything breaks after Vercel deploy:
1. Set `DATABASE_URL` back to direct Postgres URL on Vercel: `npx vercel env rm DATABASE_URL production -y && echo "DIRECT_PG_URL" | npx vercel env add DATABASE_URL production`
2. Revert schema: `git revert HEAD~N` (however many commits back)
3. Redeploy: `npx vercel --prod`
