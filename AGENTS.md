# AGENTS.md — Rabid Raccoon Governance

This is the single source of truth for AI-agent policy in this codebase. Every agent — Claude Code, Codex, Cursor, Copilot — reads this file and follows it. If a bootstrap file such as `CLAUDE.md` or `.clinerules/*` exists for tool compatibility, it must contain only a pointer back to this file and no project-specific instructions.

## Project Identity

Rabid Raccoon is a futures trading intelligence platform focused on MES (Micro E-mini S&P 500) as the primary instrument. It ingests market data, economic indicators, and news signals; trains predictive models; and surfaces analysis through a Next.js dashboard and (phase 2) a TradingView indicator via webhook.

- **Owner/Architect**: Kirk (zincdigital)
- **Repository root**: `/Volumes/Satechi Hub/rabid-raccoon`
- **Stack**: Next.js (App Router) · TypeScript · Prisma · PostgreSQL (direct via `@prisma/adapter-pg`) · Inngest · Databento · FRED · TailwindCSS · Vercel

## Current Program Status (2026-03-08)

- **Active architecture**: cloud DB + cloud runtime for the app, deployed triggers, and production ingestion.
- **Local machine ownership**: training, backtests, heavy scripts, dataset builds, options pulls, and other research-scale jobs run locally.
- **Kill-switch status**: commit `121dab8` disabled deployed `/api/inngest`; commit `a966731` restored the served Inngest endpoint on `main`.
- **Current phase**: pre-Phase-1 governance/spec/hardening closeout. Broad Phase 1 rebuild and Phase 2 capability buildout are still not approved.
- **Near-term execution order**: MACD production correction, then volume production correction, then remaining pre-Phase-1 trigger hardening.
- **Keep vs discard**: preserve valid trigger-engine work and new symbols needed for the trigger decision engine and Warbird. Discard only sidetrack detours such as the local-first-for-everything Prisma-containment path.
- **Working mode**: one fix at a time, on `main`, with gatekeeper review between fixes unless Kirk explicitly directs otherwise.

## The Three Domains

This is a monorepo with three distinct domains. Each has clear ownership of its files. Do not create cross-domain dependencies without explicit approval from Kirk.

### 1. Dashboard (Frontend)

**Purpose**: Real-time display of market analysis, forecasts, BHG setups, correlation data, and news signals.

**Owns**:

- `src/app/` (pages and API routes)
- `src/components/`
- `src/lib/` (analysis, forecast, signals, market-context, fetch-candles)
- `public/`

**Reads from**: Database (trained data, ingested market/econ data)
**Writes to**: Database only via ingestion API routes (`/api/ingest/*`, `/api/news/*`, `/api/live/*`)

### 2. Training Models

**Purpose**: Dataset construction, feature engineering, model training, and model registry management.

**Owns**:

- `scripts/build-*.ts` (dataset builders)
- `models/`
- `datasets/`
- `strategies/`
- `libraries/`
- `measured-move/`
- `mes_hft_halsey/`
- `templates/`

**Reads from**: Database (raw ingested data)
**Writes to**: File system (datasets, model artifacts), database (model registry)

### 3. TradingView Indicator (Phase 2)

**Purpose**: Renders predictions on TradingView charts via Pine Script, consuming webhook data from the dashboard.

**Owns**:

- `indicators/` (Pine Script source)

**Reads from**: Webhook payloads pushed from the dashboard
**Writes to**: Nothing — it draws, it does not store.

**Status**: Phase 2. Do not build infrastructure for this domain until Kirk says so.

### Shared Infrastructure (cross-domain)

These files serve all three domains and must not be modified without understanding the full impact:

- `prisma/` (schema, migrations) — the source of truth for data structure
- `src/lib/symbol-registry/` — the source of truth for symbols (see Symbol Registry below)
- `src/lib/ingestion-symbols.ts` — legacy adapter, reads from registry, do not add symbols here
- `src/lib/symbols.ts` — legacy adapter, reads from registry, do not add symbols here
- `src/inngest/` — scheduled jobs spanning ingestion and analysis
- `scripts/ingest-*.ts` — data ingestion pipelines
- `scripts/backfill-*.ts` — historical data backfill utilities

## Non-Negotiable Rules

These rules apply to every agent, every commit, every line of code. No exceptions.

### 1. No Hardcoded Symbol Lists

The symbol registry is the single source of truth for all symbol definitions.

- Never define a symbol array, constant, or list outside of `src/lib/symbol-registry/`.
- Never hardcode symbol codes in route files, components, Inngest functions, or scripts.
- If you need a list of symbols for a specific purpose, define a role in the registry and query it.
- Existing hardcoded lists in `symbols.ts` and `ingestion-symbols.ts` are legacy adapters being migrated. Do not add to them.
- UI behavioral logic (e.g., `if (symbol === 'VX')` for inverse display) is acceptable — it describes behavior, not membership.

**Test**: If you're about to type a symbol code as a string literal in a new array, you're doing it wrong.

### 2. No Schema Changes Without a Plan

- Every migration must be additive unless Kirk explicitly approves a breaking change.
- Before writing a migration, document: what changes, why, what depends on it, rollback plan.
- Never drop a table or column without first grepping the entire codebase for references.
- Run `prisma db pull` and diff against `schema.prisma` before proposing changes to confirm there is no drift.

### 3. No Cutting Corners

- If something feels like a shortcut, it is. Don't take it.
- Don't fake work. If you're unsure, say so and go find the answer.
- Don't guess and present it as fact. Uncertainty is honest; false confidence is deception.
- Don't ship "temporary" code without marking it with `// TODO(cleanup):` and a clear description of what needs to change.

### 4. Document Your Reasoning

- Every design decision gets a _why_, not just a _what_.
- Commit messages explain what changed and why. Not "fix stuff" or "update schema."
- If you make an assumption, call it out explicitly as an assumption.

### 5. Work Systematically

1. **Explore** before you build. Read what exists. Understand the current state.
2. **Inventory** what you found. Map dependencies before proposing changes.
3. **Clarify** only after you've done your homework. Questions should be sharp and specific.
4. **Design** with explanation. Show the schema, the relationships, the constraints, and the reasoning.
5. **Validate** your own work. What breaks? What edge cases exist?
6. **Implement** completely. Migrations, seed data, documentation — the whole thing.

### 6. One Instruction File

- `AGENTS.md` is the only agent instruction file in this repo.
- Do not create agent-specific policy docs that contain project instructions outside this file.
- If a tool requires a bootstrap file or local config (for example `CLAUDE.md`, `.clinerules`, `.cursorrules`), it must contain only: _Read and follow AGENTS.md at the repository root._

### 7. Respect Domain Boundaries

- Before modifying a file, confirm which domain owns it.
- Cross-domain changes require understanding the impact on all three domains.
- Shared infrastructure changes (Prisma schema, symbol registry, Inngest) affect everything — treat them with extra care.

## Symbol Registry

**Location**: `src/lib/symbol-registry/`
**Authority**: Database `symbols` table + `symbol_roles` + `symbol_role_members`

### How It Works

The symbol registry is a DB-authoritative system with a generated code fallback:

1. **DB layer** — `symbols` table defines identity. `symbol_roles` and `symbol_role_members` define group membership (e.g., `INGESTION_ACTIVE`, `CORRELATION_SET`, `CROSS_ASSET_TRAINING`).
2. **Service layer** — `src/lib/symbol-registry/index.ts` exposes query functions: `getSymbolsByRole()`, `getPrimarySymbol()`, `getActiveSymbols()`, `getProviderMapping()`.
3. **Fallback layer** — `src/lib/symbol-registry/snapshot.ts` is auto-generated from DB. Used at startup or if DB is unreachable. Hierarchy: DB → snapshot → fail loudly.

### Rules

- To add a new symbol: insert into `symbols` table, assign to appropriate roles, regenerate snapshot.
- To change which symbols a feature uses: update `symbol_role_members`, not code.
- Legacy files (`symbols.ts`, `ingestion-symbols.ts`) are thin adapters that call the registry. They will be removed once all consumers are migrated.

## Naming Conventions

### Database (Prisma Schema)

| Element               | Convention                                       | Example                             |
| --------------------- | ------------------------------------------------ | ----------------------------------- |
| Models                | PascalCase                                       | `MktFuturesMes1h`                   |
| Table names (`@@map`) | snake_case                                       | `mkt_futures_mes_1h`                |
| Columns               | camelCase in Prisma, snake_case in DB via `@map` | `eventTime` → `event_time`          |
| Enums                 | PascalCase                                       | `DataSource`, `EconCategory`        |
| Enum values           | SCREAMING_SNAKE                                  | `DATABENTO`, `TARGET_HIT`           |
| Indexes               | snake_case descriptive                           | `mkt_futures_mes_1h_event_time_key` |

### TypeScript

| Element             | Convention                     | Example                           |
| ------------------- | ------------------------------ | --------------------------------- |
| Files               | kebab-case                     | `symbol-registry.ts`              |
| Variables/functions | camelCase                      | `getSymbolsByRole()`              |
| Constants           | SCREAMING_SNAKE                | `PRIMARY_SYMBOL`                  |
| Types/interfaces    | PascalCase                     | `IngestionSymbol`                 |
| Enums (TS)          | PascalCase + PascalCase values | Prefer Prisma enums over TS enums |

### Timestamps

- All timestamps are UTC.
- Use `@db.Timestamptz(6)` for all timestamp columns.
- Use `@db.Date` for date-only columns (economic data, daily candles).
- Never store local time. Convert at the display layer.

## Migration Policy

### Before Writing a Migration

1. Run `prisma db pull` and diff against `schema.prisma` — confirm zero drift.
2. Grep the codebase for any table/column you plan to modify or drop.
3. Document the change: what, why, impact, rollback.
4. Get Kirk's approval for any destructive change (drop, rename, type change).

### Migration Types

- **Additive** (new table, new column with default, new index): Safe. Proceed after review.
- **Backfill** (populate new column from existing data): Must be idempotent. Must handle nulls.
- **Destructive** (drop table, drop column, rename, type change): Requires explicit approval. Must be preceded by a codebase grep showing zero live references.

### Migration Naming

- **Format**: `YYYYMMDDHHMMSS_descriptive_name`
- **Example**: `20260222120000_add_symbol_roles_table`

### Ordering

- One concern per migration. Don't bundle unrelated changes.
- Schema changes and data backfills are separate migrations.
- Always test migration ordering by running `prisma migrate deploy` against a fresh DB.

## Data Quality Requirements

Every table must have:

- **Primary key** — always `BigInt @id @default(autoincrement())` unless there's a natural key.
- **Unique constraint** — on the natural dedupe key (e.g., `[seriesId, eventDate]`).
- **NOT NULL** — on all columns that should never be null. Don't use nullable as a default.
- **Foreign keys** — every reference to another table must have a formal FK with appropriate `onDelete` behavior.
- **Temporal columns** — `ingestedAt` (when we received it) and `knowledgeTime` (when we learned about it) on all data tables.
- **Row hash** — `rowHash` column for idempotent upserts on ingestion tables.

## Ingestion Rules

- All ingestion paths must be idempotent — running the same ingestion twice produces the same result.
- Use `createMany({ skipDuplicates: true })` or upsert patterns.
- Every ingestion run must create an `IngestionRun` record with status, row counts, and timing.
- Log failures — never silently swallow errors.

### Prisma Connection Rules

Prisma Accelerate is **not the default**. Direct Postgres is.

- `src/lib/prisma.ts` uses `DIRECT_URL` (or `LOCAL_DATABASE_URL`) by default via `@prisma/adapter-pg`. Zero per-operation cost.
- Accelerate (`prisma+postgres://`) is opt-in only: set `USE_ACCELERATE=1` to enable. Only do this if queries use `cacheStrategy` for edge caching.
- **Never route bulk writes through Accelerate.** It charges per operation and silently drops data.
- High-frequency writes (SSE refresh, ingestion) use `src/lib/direct-pool.ts` (raw `pg.Pool` on `DIRECT_URL`).
- Python scripts connect via `DIRECT_URL` from `.env.local` using `psycopg2` — they never touch Accelerate.

| Env Variable | Purpose | When Used |
|---|---|---|
| `DIRECT_URL` | Direct Postgres (Prisma + Python) | Default everywhere |
| `LOCAL_DATABASE_URL` | Local dev Postgres | Fallback if `DIRECT_URL` not set |
| `DATABASE_URL` | Accelerate proxy URL | Only when `USE_ACCELERATE=1` |
| `USE_ACCELERATE` | Opt-in flag for Accelerate | Set to `1` only for edge-cached reads |

### Databento Options Data

Options market data is pulled via the **Databento Python SDK** (`databento` package in `.venv-finance`), NOT the TypeScript REST wrapper. The data volume is too large for streaming.

**15 CME option parents**: ES.OPT, NQ.OPT, OG.OPT, SO.OPT, LO.OPT, OKE.OPT, ON.OPT, OH.OPT, OB.OPT, HXE.OPT, OZN.OPT, OZB.OPT, OZF.OPT, EUU.OPT, JPU.OPT

**Critical knowledge:**

- `stype_in='parent'` returns ALL child contracts (~3K for ES.OPT = ~288K stat rows/day). Use `batch.submit_job()` or weekly streaming chunks for ES/NQ. Monthly works for the rest.
- `statistics` schema stat_types: 3=Settlement, 6=Volume, 9=OI, 14=IV, 15=Delta. Filter early to reduce storage.
- Definition files (strikes, expirations, put/call class) are on disk at the Databento Data Dump: `/Volumes/Satechi Hub/Databento Data Dump/Options/definitions/` (2010–2026, `.dbn.zst` format).
- Kirk has a Databento subscription — all pulls are $0.
- Pull scripts: `scripts/pull-options-statistics.py`, `scripts/pull-options-ohlcv.py`
- Output: `datasets/options-statistics/<SYMBOL>/YYYY-MM.parquet`, `datasets/options-ohlcv/<SYMBOL>/YYYY-MM.parquet`

## File Organization

```
rabid-raccoon/
├── AGENTS.md                    ← You are here. The only agent instruction file.
├── ARCHITECTURE.md              ← System design, data flow, domain boundaries
├── CONVENTIONS.md               ← Detailed coding standards and patterns
├── prisma/
│   ├── schema.prisma            ← Source of truth for data model
│   └── migrations/              ← Ordered, documented migrations
├── src/
│   ├── app/                     ← Next.js pages + API routes (Dashboard domain)
│   ├── components/              ← React components (Dashboard domain)
│   ├── inngest/                 ← Scheduled jobs (Shared infrastructure)
│   │   └── functions/           ← Individual Inngest function files
│   └── lib/                     ← Shared libraries
│       ├── symbol-registry/     ← THE source of truth for symbols
│       ├── symbols.ts           ← LEGACY adapter — do not modify
│       ├── ingestion-symbols.ts ← LEGACY adapter — do not modify
│       └── ...                  ← Analysis, forecast, signals, etc.
├── scripts/                     ← Ingestion + backfill + dataset scripts
├── indicators/                  ← TradingView Pine Script (Phase 2)
├── models/                      ← Trained model artifacts
├── datasets/                    ← Built datasets for training
│   ├── options-statistics/      ← Databento options stats (parquet, by symbol/month)
│   └── options-ohlcv/           ← Databento options daily OHLCV (parquet, by symbol/month)
├── strategies/                  ← Trading strategy definitions
├── libraries/                   ← External library integrations
├── measured-move/               ← Measured move detection logic
├── mes_hft_halsey/              ← MES HFT strategy (Halsey variant)
└── templates/                   ← Document/report templates
```

## Memory MCP (Mandatory)

All agents MUST use the Memory MCP server to persist and recall project decisions, corrections, and context across sessions.

**Server**: `@modelcontextprotocol/server-memory` (stdio)
**Memory file**: `.claude/memory.jsonl` (repo-local, shared across all agents)

### Configuration

The Memory MCP is pre-configured for each agent platform:

| Platform              | Config file                 | Key format          |
| --------------------- | --------------------------- | ------------------- |
| Claude Code / Desktop | `.mcp.json` (repo root)     | `mcpServers.memory` |
| VS Code Copilot       | `.vscode/mcp.json`          | `servers.memory`    |
| Cline                 | `.clinerules` + `.mcp.json` | Uses `.mcp.json`    |
| Cursor                | `.mcp.json`                 | Uses `.mcp.json`    |

### Rules

1. **Search memory first** — Before starting any task, search memory for keywords from the request + "rabid-raccoon" + "Kirk". This catches past decisions and corrections.
2. **Store immediately** — When Kirk states a preference, makes a correction, or you learn something project-specific, write it to memory before moving on.
3. **Never skip memory** — Even if a task seems simple. Past context prevents repeated mistakes.
4. **Memory is shared** — All agents read/write the same `.claude/memory.jsonl`. Keep entries clean and factual.

## Agent Workflow

When you receive a task:

1. **Search memory** for relevant context. Always. No exceptions.
2. **Read this file first.** Every time. Don't assume you remember it.
3. **Respect the role split**: Chat is the gatekeeper; Codex is the executor. Executors do not self-approve scope, phase changes, or baseline truth.
4. **Stay on `main` unless Kirk explicitly says otherwise.** Do not create branches by default.
5. **Identify which domain(s)** the task touches. If it crosses domains, flag it.
6. **Explore the current state** of the files you'll modify. Don't assume — verify.
7. **Check the symbol registry** if your task involves any symbol references.
8. **Check the migration history** if your task involves schema changes.
9. **Propose before you build** for any structural change. Show the plan, get approval.
10. **Execute one fix at a time.** No bundled cleanup, no opportunistic refactors, no "while I'm here" scope stretching.
11. **Commit incrementally** with clear messages. Not one giant commit at the end.
12. **Verify your work.** Run the build. Run the linter. Check for regressions.
13. **Store new decisions/corrections to memory** before ending the session.

## WARBIRD Model Training — Hard Rules

These are Kirk's decisions. They override any conflicting information in plan files, memory, or prior conversations.

### Architecture

- **ONE unified MES model** — NOT separate models per symbol. MES is the ONLY prediction target.
- All other symbols (63 in the DB, 39 active) are **features** — same as FRED, news, GPR, Trump data. They are inputs, not targets.
- One flat dataset per horizon/target. One row per timestamp. All data sources as columns.

### Dataset

- **EVERYTHING in the database goes into the dataset.** All 63 symbols, all 10 econ tables, all FRED series, all news/GPR/Trump, calendar, options — no pre-filtering.
- Feature count will be 400-600+ columns. The IC ranking + cluster dedup (top 30 per fold) handles pruning.
- Feature priority: macro baselines (yields, rates, gold, credit, VIX) are mandatory for regime context. Reaction features (news shocks, vol spikes, policy actions, cross-asset velocity) provide the intraday edge.
- Cross-asset symbols are features for their **intraday reactions**, not long-term trends. How NQ/CL/ZN/GC move in the same hour tells the model what regime MES is in.

### AutoGluon Settings

```python
AG_SETTINGS = {
    'presets': 'best_quality',
    'num_bag_folds': 5,                    # MAX 5 — not 8
    'num_stack_levels': 2,
    'dynamic_stacking': 'auto',
    'excluded_model_types': [],            # ALL model types included
    'ag_args_fit': {
        'num_early_stopping_rounds': 50,
        'ag.max_memory_usage_ratio': 0.8,
    },
    'ag_args_ensemble': {
        'fold_fitting_strategy': 'sequential_local',
    },
}
```

### Hardware & Training

- **Machine**: Mac Mini M4 Pro, 24GB RAM, 12 CPU cores
- **Peak RAM**: 8-10GB (NOT 2-4GB)
- **Bottleneck**: CPU, NOT RAM
- **Training sequence**: 1 horizon → 1 target → 1 fold at a time (strictly sequential)
- **Time limits**: 14400s (4h) per fold for price, 7200s (2h) for MAE/MFE
- **NEVER run Ollama or local AI during training** — M4 Pro reserved for AutoGluon

### Targets

- **Regression** (price prediction), NOT classification
- 3 targets: price, MAE (max adverse excursion), MFE (max favorable excursion)
- 4 horizons: 1h, 4h, 1d, 1w → 12 models total (3 targets × 4 horizons)
- Targets derived from MES data: `close.shift(-N)` for price, trailing high/low for MAE/MFE

### Feature Selection (per fold)

- IC ranking (Spearman correlation with target)
- Hierarchical cluster dedup (|r| > 0.85, keep IC-best per cluster)
- Top 30 features per fold
- Walk-forward CV with purge/embargo (Lopez de Prado)

## What NOT to Do

- Do not create additional agent instruction files.
- Do not put project-specific guidance in `CLAUDE.md`, `.clinerules`, `.cursorrules`, or similar bootstrap files.
- Do not create new branches unless Kirk explicitly requests one.
- Do not hardcode symbol lists.
- Do not modify `symbols.ts` or `ingestion-symbols.ts` (they are legacy adapters).
- Do not run destructive migrations without Kirk's approval.
- Do not add dependencies without justification.
- Do not silence errors or swallow exceptions.
- Do not commit dead code. If it's deprecated, remove it or mark it clearly.
- Do not revive the parked local-first / Prisma-containment detour as the active path.
- Do not discard valid trigger-engine or new-symbol work just because it was developed during that sidetrack.
- Do not assume. Verify.

---

_Last updated: 2026-03-08_
_Maintained by: Kirk (architect)_
