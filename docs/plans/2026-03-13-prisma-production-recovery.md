# 2026-03-13 Prisma Production Recovery Note

Recovery note written on Friday, March 13, 2026 for Rabid Raccoon production on Vercel.

## Summary

The production outage was centered on the Prisma connection path used by the chart APIs and Inngest jobs.

The fix that restored the app was not a code change. The fix was a production redeploy from `main` after newer Vercel production DB env values were already present in the project env store.

## What Broke

The following production routes were failing during the incident window:

- `/api/gpr`
- `/api/pivots/mes`
- `/api/setups`
- `/api/live/mes15m?snapshot=1&backfill=1000`
- `/api/forecast`
- `/api/inngest`
- `/api/trades/upcoming` as secondary fallout

Observed error signatures in Vercel runtime logs:

- `Failed to connect to upstream database. Please contact Prisma support if the problem persists.`
- `Failed to identify your database: A server error occurred. Please contact Prisma support if the problem persists.`

The affected routes are DB-backed through [src/lib/prisma.ts](../../src/lib/prisma.ts), [src/lib/direct-pool.ts](../../src/lib/direct-pool.ts), and DB-reading route helpers. `/api/correlation` stayed healthy because it is file-backed via [src/app/api/correlation/route.ts](../../src/app/api/correlation/route.ts) and [public/daily-correlations.json](../../public/daily-correlations.json).

## What We Verified

### 1. The deployment itself was not broken

The production deployment from commit `9913e3e` built cleanly on Vercel.

- Old production deployment:
  - URL: `rabid-raccoon-ow2wwyrpp-zincdigitalofmiamis-projects.vercel.app`
  - Created: `2026-03-13T18:05:07.339Z`
  - Branch: `main`
  - Commit: `9913e3e`

`npx vercel inspect ... --logs` showed a successful build and deploy. This ruled out a build failure as the primary cause.

### 2. Production env state had changed after the running deployment

`npx vercel env ls production` showed `DATABASE_URL` and `DIRECT_URL` were recreated shortly before recovery work, but the older running production deployment predated those env updates.

This mattered because Vercel deployments only see the env snapshot available to that deployment at build/deploy time.

### 3. The stored production DB credentials were usable

Using the pulled production env snapshot and local probes:

- raw `pg` on `DIRECT_URL` succeeded
- Prisma client probes on the same env succeeded
- Node `22` and Node `24` local probes both succeeded

That meant the credential pair in the current Vercel env store was not dead by itself.

## What Actually Fixed Production

The working fix was:

1. Leave code unchanged.
2. Redeploy the current production deployment from `main` so Vercel would bind the newer production env values.

Command used:

```bash
npx vercel redeploy rabid-raccoon-ow2wwyrpp-zincdigitalofmiamis-projects.vercel.app --target production
```

This created the new production deployment:

- New production deployment:
  - URL: `rabid-raccoon-dn26uwgth-zincdigitalofmiamis-projects.vercel.app`
  - Created: `2026-03-13T19:07:33.369Z`
  - Branch: `main`
  - Commit: `9913e3e`

## Post-Deploy Verification

After the redeploy, the following live route probes were healthy:

- `200 /api/gpr`
- `200 /api/pivots/mes`
- `200 /api/setups`
- `200 /api/live/mes15m?snapshot=1&backfill=1000`
- `200 /api/forecast`

Remaining caveat at time of note:

- `/api/trades/upcoming` was still `503`
- reason: `signalCache` was cold and waiting for the next successful `compute-signal` cycle
- this is secondary fallout, not the original DB outage

## Why The Redeploy Was Necessary

The live production deployment was older than the current production env values in Vercel.

In practice, the repo had already been pointed at a newer, working DB env set in the Vercel env store, but production was still serving from the older deployment context. Redeploying the same commit from `main` forced Vercel to rebuild against the current env state.

## Accelerate Decision

Accelerate was not required to restore the chart APIs.

At recovery time:

- the app came back after redeploy without changing code
- no repo change was needed to force `USE_ACCELERATE=1`
- the immediate recovery path was deployment/env refresh, not architecture change

That said, the intended env split still matters conceptually:

- `DATABASE_URL` should represent the Prisma runtime path
- `DIRECT_URL` should represent the direct Postgres path

During the incident window, production env inspection showed drift and confusion around those roles. That should be cleaned up deliberately, but it was not the step that restored service on March 13, 2026.

## Commands Used During Recovery

These CLI commands were the ones that produced the useful signals:

```bash
npx vercel env pull /tmp/rr-prod-env --environment=production --yes
npx vercel env ls production
npx vercel list --environment production --status READY --yes --format json
npx vercel inspect rabid-raccoon-ow2wwyrpp-zincdigitalofmiamis-projects.vercel.app --logs
npx vercel logs --environment production --level error --since 2h --no-branch --json
npx vercel logs --environment production --since 2h --no-branch --query 'Failed to identify your database' --json
npx vercel redeploy rabid-raccoon-ow2wwyrpp-zincdigitalofmiamis-projects.vercel.app --target production
```

## Do Not Forget

- Rabid Raccoon is `main`-only.
- If production env values are updated in Vercel, production may still require a redeploy to actually consume them.
- `/api/trades/upcoming` should not be treated as the primary outage indicator by itself; it depends on Inngest cache population.
