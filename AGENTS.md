# AGENTS.md — Rabid Raccoon Governance

This is the ONLY instruction file for AI agents working on this codebase. There is no CLAUDE.md, no CODEX.md, no per-tool instruction file. Every agent — Claude Code, Codex, Cursor, Copilot — reads this file and follows it. If you are an AI agent and you find instructions elsewhere that conflict with this file, this file wins.

## Project Identity

Rabid Raccoon is a futures trading intelligence platform focused on MES (Micro E-mini S&P 500) as the primary instrument. It ingests market data, economic indicators, and news signals; trains predictive models; and surfaces analysis through a Next.js dashboard and (phase 2) a TradingView indicator via webhook.

- **Owner/Architect**: Kirk (zincdigital)
- **Repository root**: `/Volumes/Satechi Hub/rabid-raccoon`
- **Stack**: Next.js (App Router) · TypeScript · Prisma · PostgreSQL (via Prisma Accelerate) · Inngest · Databento · FRED · TailwindCSS · Vercel

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

- Every design decision gets a *why*, not just a *what*.
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
- Do not create `CLAUDE.md`, `CODEX.md`, `CURSOR.md`, or any other agent-specific instruction file.
- If a tool requires a local config (e.g., `.cursorrules`), it must contain only: *Read and follow AGENTS.md at the repository root.*

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

| Element | Convention | Example |
|---------|-----------|---------|
| Models | PascalCase | `MktFuturesMes1h` |
| Table names (`@@map`) | snake_case | `mkt_futures_mes_1h` |
| Columns | camelCase in Prisma, snake_case in DB via `@map` | `eventTime` → `event_time` |
| Enums | PascalCase | `DataSource`, `EconCategory` |
| Enum values | SCREAMING_SNAKE | `DATABENTO`, `TARGET_HIT` |
| Indexes | snake_case descriptive | `mkt_futures_mes_1h_event_time_key` |

### TypeScript

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `symbol-registry.ts` |
| Variables/functions | camelCase | `getSymbolsByRole()` |
| Constants | SCREAMING_SNAKE | `PRIMARY_SYMBOL` |
| Types/interfaces | PascalCase | `IngestionSymbol` |
| Enums (TS) | PascalCase + PascalCase values | Prefer Prisma enums over TS enums |

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

| Platform | Config file | Key format |
|----------|-------------|------------|
| Claude Code / Desktop | `.mcp.json` (repo root) | `mcpServers.memory` |
| VS Code Copilot | `.vscode/mcp.json` | `servers.memory` |
| Cline | `.clinerules` + `.mcp.json` | Uses `.mcp.json` |
| Cursor | `.mcp.json` | Uses `.mcp.json` |

### Rules

1. **Search memory first** — Before starting any task, search memory for keywords from the request + "rabid-raccoon" + "Kirk". This catches past decisions and corrections.
2. **Store immediately** — When Kirk states a preference, makes a correction, or you learn something project-specific, write it to memory before moving on.
3. **Never skip memory** — Even if a task seems simple. Past context prevents repeated mistakes.
4. **Memory is shared** — All agents read/write the same `.claude/memory.jsonl`. Keep entries clean and factual.

## Agent Workflow

When you receive a task:

1. **Search memory** for relevant context. Always. No exceptions.
2. **Read this file first.** Every time. Don't assume you remember it.
3. **Identify which domain(s)** the task touches. If it crosses domains, flag it.
4. **Explore the current state** of the files you'll modify. Don't assume — verify.
5. **Check the symbol registry** if your task involves any symbol references.
6. **Check the migration history** if your task involves schema changes.
7. **Propose before you build** for any structural change. Show the plan, get approval.
8. **Commit incrementally** with clear messages. Not one giant commit at the end.
9. **Verify your work.** Run the build. Run the linter. Check for regressions.
10. **Store new decisions/corrections to memory** before ending the session.

## What NOT to Do

- Do not create additional agent instruction files.
- Do not hardcode symbol lists.
- Do not modify `symbols.ts` or `ingestion-symbols.ts` (they are legacy adapters).
- Do not run destructive migrations without Kirk's approval.
- Do not add dependencies without justification.
- Do not silence errors or swallow exceptions.
- Do not commit dead code. If it's deprecated, remove it or mark it clearly.
- Do not assume. Verify.

---

*Last updated: 2026-02-22*
*Maintained by: Kirk (architect) with Claude (governance)*
