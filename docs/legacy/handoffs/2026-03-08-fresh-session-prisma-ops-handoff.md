# Pre-Phase-1 Fresh Session Handoff (Prisma Ops Reduction)

> Historical parked sidetrack.
> Do not use this document as the active baseline.
> The local-first / Prisma-ops reduction path described here is not the current phase path.
> Current architecture is cloud DB + cloud runtime for production app/trigger/ingestion, with local ownership for training, backtests, heavy scripts, and dataset builds.
> Preserve valid trigger-engine and new-symbol work separately from this sidetrack; do not revive the detour as current strategy.

Date: 2026-03-08
Repo: `/Volumes/Satechi Hub/rabid-raccoon`
Scope: Handoff preparation only (no implementation)

## 1. Purpose of handoff
Provide a clean, verifiable restart package for a new Codex chat to continue pre-Phase-1 governance and Prisma Cloud Operations reduction work without mixing committed truth and local candidate work.

## 2. Exact git state
Verified at handoff time:
- Current branch: `main`
- Current HEAD: `8c7816a`
- `origin/main`: `8c7816a`
- `8c7816a` commit message: `docs(handoff): checkpoint pre-phase1 trigger governance`
- `8c7816a` changed files (docs-only):
  - `docs/legacy/handoffs/2026-03-07-pre-phase1-trigger-governance-handoff.md`
  - `docs/legacy/handoffs/2026-03-08-pre-phase1-trigger-governance-approval.md`

Current dirty/untracked working tree:
- Modified:
  - `scripts/compute-volume-features.py`
  - `src/inngest/functions/compute-signal.ts`
  - `src/lib/trade-features.ts`
- Untracked:
  - `docs/legacy/handoffs/2026-03-08-fresh-session-prisma-ops-handoff.md` (this handoff file itself)
  - `docs/volume-feature-contract.md`
  - `src/lib/runtime-volume-features.ts`
  - `src/lib/volume-contract.ts`

## 3. HEAD/main truth
Committed truth at `HEAD`/`origin/main` (`8c7816a`):

### Compute-signal volume path
`src/inngest/functions/compute-signal.ts` in HEAD still executes Python volume logic:
- References `scripts/compute-volume-features.py`
- Executes `python3` via child process
- Parses Python JSON into volume features

### Runtime-volume files in HEAD
These files are not present in HEAD:
- `src/lib/runtime-volume-features.ts` (missing)
- `src/lib/volume-contract.ts` (missing)

### Approval-doc mismatch in HEAD
`docs/legacy/handoffs/2026-03-08-pre-phase1-trigger-governance-approval.md` currently references runtime-volume/volume-contract files and a Node runtime-volume path that are not committed in HEAD.

## 4. Local candidate truth
Local working tree contains candidate (not committed) runtime-volume migration pieces:
- Modified `src/inngest/functions/compute-signal.ts`
- Modified `src/lib/trade-features.ts`
- Untracked `src/lib/runtime-volume-features.ts`
- Untracked `src/lib/volume-contract.ts`
- Untracked `docs/volume-feature-contract.md`
- Modified `scripts/compute-volume-features.py`

Interpretation:
- Local candidate path exists.
- It is not pushed repo truth.
- Governance claims must not describe local candidate behavior as committed behavior.

## 5. Governance state
Status at this checkpoint:
- Pre-Phase-1 governance closeout is still active.
- No approval to begin broad Phase 1 trigger rebuild.
- No approval to begin Phase 2 capability buildout.
- This handoff pass performed verification and documentation only.

## 6. Prisma Cloud Ops reduction constraint
First-class architecture constraint:
- Local execution alone is insufficient if jobs still route to cloud DB.
- Target architecture is:
  - local execution
  - local storage/processing
  - minimal cloud publish boundary

Source priority remains:
1. Databento
2. FRED
3. Yahoo fallback only
4. Options-derived proxies only when justified

## 7. Exact unresolved blockers
1. HEAD/main volume-path truth mismatch in approval doc:
- Current pushed doc claims Node runtime-volume path that is not in HEAD.

2. Heavy script routing remains porous:
- Many heavy scripts still import `src/lib/prisma` directly.
- Local runs can still hit cloud DB depending on env resolution.

3. Deployed Inngest still contains heavy non-runtime jobs:
- Ingestion/backfill/news/dataset-style jobs remain cloud-registered and cloud-executed.

4. Ad-hoc cloud ingestion API surfaces remain present:
- `/api/ingest/econ-calendar`
- `/api/news/scrape`
- `/api/news/scrape-reports`

## 8. Strict local-routing blocker
Hard blocker for ops reduction:
- `scripts/script-db.ts` resolution order includes `DIRECT_URL` and `DATABASE_URL` fallback:
  - `SCRIPT_DATABASE_URL`
  - `LOCAL_DATABASE_URL`
  - `DIRECT_URL`
  - `DATABASE_URL`
- This is unsafe for strict local ownership because heavy scripts can silently run against cloud DB.

Required remediation direction (bounded):
1. Split script DB modes:
- strict local mode: only `SCRIPT_DATABASE_URL` / `LOCAL_DATABASE_URL`
- explicit cloud publish mode: separate dedicated cloud publish URL
2. Make heavy classes hard-fail without strict-local URL:
- ingest/backfill/build/backtest/training scripts
3. Add guardrails:
- prevent heavy scripts from importing `src/lib/prisma`
- require explicit publish intent for cloud summary writes

## 9. Prisma-touching surface count (corrected methodology)
Counts must be tied to an explicit counting method. This section reports two separate methods; do not collapse them into one number.

Scope for both methods:
- `src/app/api`
- `src/inngest`
- `scripts`
- `src/lib`

### Method A — Direct `src/lib/prisma` import surface
Definition:
- Files in scope that directly import the Prisma proxy module (`src/lib/prisma`) via any supported path form (`@/lib/prisma`, `../src/lib/prisma`, `../../lib/prisma`, `./prisma`, etc.).
- This is the direct Prisma-consumer surface.

Reproducible commands:
- HEAD/main:
  - `git grep -l -E "from ['\"]((@/lib/prisma)|((\\.\\./)+src/lib/prisma)|((\\.\\./)+lib/prisma)|(src/lib/prisma)|(\\./prisma))['\"]" HEAD -- src/app/api src/inngest scripts src/lib | sed 's#^HEAD:##' | sort`
- Local working tree:
  - `rg -l -g '*.ts' -g '*.tsx' -g '*.js' -g '*.mjs' "from ['\"]((@/lib/prisma)|((\\.\\./)+src/lib/prisma)|((\\.\\./)+lib/prisma)|(src/lib/prisma)|(\\./prisma))['\"]" src/app/api src/inngest scripts src/lib | sort`

Results:
- HEAD/main: **61 files**
  - `scripts`: 32
  - `src/app`: 6
  - `src/inngest`: 15
  - `src/lib`: 8
- Local working tree: **62 files**
  - `scripts`: 32
  - `src/app`: 6
  - `src/inngest`: 15
  - `src/lib`: 9
- Delta: **+1 local-only file** (`src/lib/runtime-volume-features.ts`)

### Method B — Broader DB-client import surface
Definition:
- Files in scope that import any DB-client entrypoint:
  - `src/lib/prisma`
  - `scripts/script-db`
  - `src/lib/direct-pool`
- This is broader than Method A and includes direct `pg`/script-db consumers.

Reproducible commands:
- HEAD/main:
  - `git grep -l -E "from ['\"]((@/lib/prisma)|((\\.\\./)+src/lib/prisma)|((\\.\\./)+lib/prisma)|(src/lib/prisma)|(\\./prisma)|((\\.\\./)+scripts/script-db)|(\\./script-db)|((\\.\\./)+src/lib/direct-pool)|((\\.\\./)+lib/direct-pool)|(@/lib/direct-pool)|(src/lib/direct-pool)|(\\./direct-pool))['\"]" HEAD -- src/app/api src/inngest scripts src/lib | sed 's#^HEAD:##' | sort`
- Local working tree:
  - `rg -l -g '*.ts' -g '*.tsx' -g '*.js' -g '*.mjs' "from ['\"]((@/lib/prisma)|((\\.\\./)+src/lib/prisma)|((\\.\\./)+lib/prisma)|(src/lib/prisma)|(\\./prisma)|((\\.\\./)+scripts/script-db)|(\\./script-db)|((\\.\\./)+src/lib/direct-pool)|((\\.\\./)+lib/direct-pool)|(@/lib/direct-pool)|(src/lib/direct-pool)|(\\./direct-pool))['\"]" src/app/api src/inngest scripts src/lib | sort`

Results:
- HEAD/main: **67 files**
  - `scripts`: 35
  - `src/app`: 6
  - `src/inngest`: 15
  - `src/lib`: 11
- Local working tree: **68 files**
  - `scripts`: 35
  - `src/app`: 6
  - `src/inngest`: 15
  - `src/lib`: 12
- Delta: **+1 local-only file** (`src/lib/runtime-volume-features.ts`)

## 10. Highest-cost Prisma suspects
High-impact cloud-op suspects based on cadence + query/write shape:
1. `src/inngest/functions/compute-signal.ts` (15m cadence, multi-stage DB access)
2. `src/lib/trade-features.ts` (news counts + macro queries per run)
3. `src/lib/event-awareness.ts` (event + surprise-history queries)
4. `src/lib/outcome-tracker.ts` via `check-trade-outcomes` (recurring scan/update)
5. `src/inngest/functions/econ-*` family (daily FRED ingestion in cloud runtime)
6. `src/inngest/functions/mkt-*` daily non-15m ingest wrappers (cloud ingestion)
7. `src/inngest/backfill-mes.ts` (backfill-scale writes)
8. `src/inngest/functions/news-signals.ts` + `src/lib/news-scrape.ts` (looped scrape/upsert)
9. `src/inngest/functions/check-symbol-coverage.ts` (coverage audit + symbol mutation)
10. `src/app/api/{forecast,market-data,batch,analyse/*}` through broad DB fan-out

## 11. What must move local first
Default local-script owned first-wave candidates:
1. Daily heavy ingest wrappers currently in deployed Inngest (`econ-*`, non-15m `mkt-*`)
2. Backfills (`src/inngest/backfill-mes.ts` equivalent workloads)
3. News ingestion loops (`news-signals`, `alt-news`, `fred-news`)
4. Measured-move ingestion and non-runtime feature derivations
5. Dataset builders/backtests/training prep still importing `src/lib/prisma`
6. Symbol-coverage audits and symbol-activation workflows

## 12. What must remain cloud-runtime
Keep cloud runtime limited to truly runtime-critical paths:
1. `compute-signal` trigger run (bounded query budget)
2. MES live refresh needed for runtime reads (`mkt-mes-15m` path)
3. Thin runtime read APIs used by frontend:
- `/api/trades/upcoming`
- `/api/setups`
- `/api/setups/history`
- `/api/live/mes*`
- `/api/pivots/mes`
- `/api/gpr`
4. Inngest route itself, but with reduced runtime-only function registry

## 13. First-wave bounded implementation brief
Prisma/Ops reduction only (no schema changes, no Phase 1 rebuild):

1. Enforce strict local routing in `scripts/script-db.ts`:
- heavy mode must not fall back to `DIRECT_URL`/`DATABASE_URL`
- explicit cloud publish mode only for compact publish steps

2. Migrate heavy scripts off `src/lib/prisma` imports:
- target the 32-script subset first

3. Reduce deployed Inngest registry to runtime-only jobs:
- remove cloud registration for heavy ingest/backfill/news/audit jobs

4. Disable ad-hoc cloud ingestion API endpoints in deployed runtime:
- `/api/ingest/econ-calendar`
- `/api/news/scrape`
- `/api/news/scrape-reports`

5. Keep compact cloud publish boundary:
- local heavy processing, cloud summary publication only

6. Add verification gates before any broader work:
- strict-local hard-fail test for heavy scripts
- no heavy script imports `src/lib/prisma`
- runtime registry contains runtime-only jobs
- HEAD docs align with committed runtime behavior

## 14. Fresh-chat restart prompt
Use this prompt in a new Codex chat:

```text
You are working in /Volumes/Satechi Hub/rabid-raccoon.

Read first:
1) AGENTS.md
2) docs/legacy/handoffs/2026-03-08-fresh-session-prisma-ops-handoff.md
3) docs/legacy/handoffs/2026-03-08-pre-phase1-trigger-governance-approval.md
4) docs/legacy/handoffs/2026-03-07-pre-phase1-trigger-governance-handoff.md

Hard rules:
- Do not mix HEAD/main truth with local working-tree candidate truth.
- Do not start Phase 1 rebuild.
- Do not start Phase 2 capability buildout.
- No schema changes or migrations.
- Keep pre-Phase-1 governance boundaries intact.
- Treat Prisma Cloud Ops reduction as a bounded side-constraint, not a scope expansion.

First tasks:
1. Re-verify git truth (`branch`, `HEAD`, `origin/main`, dirty files).
2. Re-verify HEAD compute-signal volume path and runtime-volume file presence.
3. Recompute and verify the Prisma-touching surface count from repo truth (state counting methodology explicitly).
4. Produce an implementation plan for first-wave bounded ops-reduction work:
   - strict local script routing hardening
   - migrate heavy scripts off src/lib/prisma
   - reduce Inngest registry to runtime-only
   - stop ad-hoc cloud ingestion endpoints
   - define compact publish boundary

Return findings first, then the bounded implementation plan.
Do not implement until chat gatekeeper approves.
```
