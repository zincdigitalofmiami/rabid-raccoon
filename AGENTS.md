# Rabid Raccoon — AI Agent Rules

---
## 🚨 MANDATORY SESSION STARTUP — NO EXCEPTIONS

Before ANY response, code, or analysis — execute this checklist in order:

1. **Read this file completely** before taking any action.
2. **Memory MCP** — Search memory for prior decisions relevant to the current task. Query: task keywords + "rabid-raccoon" + "Kirk".

**If you skipped any of these and the task warranted them — stop, acknowledge it, run them, then continue.**

---

## What This Project Is

Multi-feature Pine Script v6 trading indicator for MES (Micro E-mini S&P 500) Futures.
Author: Kirk / ZINC Digital.
Purpose: Detection, analysis, and risk management tooling for discretionary traders.
No automated execution. Indicator/signal only.

---

## Hard Rules

### Pine Script Version
- **v6 ONLY**. Never write v5 syntax. Never downgrade.
- Use `//@version=6` at top of every script.

### Visualization Language (shared with ZINC-FUSION-V15)
- Price targets render as **horizontal lines / Target Zones** — not cones, not bands, not funnels.
- Probability or confidence stated as: "X% probability of this price area"
- BANNED words: "cone", "band", "funnel", "channel" (when referring to target zones)

### Architecture
- Single indicator file with `//#region` blocks for modularity.
- Each feature has a toggle input (`input.bool`) for isolation/debugging.
- UDTs for structured data (MeasuredMove, FibLevel, RiskProfile, etc.).
- Debug mode activates status dashboard + log output.

### Development Workflow
1. Edit in VS Code (kaigouthro Pine Script extension).
2. Validate — extension catches errors via TradingView's pine-facade API.
3. Copy-paste into TradingView Pine Editor → "Add to Chart".
4. Debug using Pine Logs, Pine Profiler, debug dashboard.
5. Never commit broken Pine Script — validate first.

### No Execution Logic
- This is an indicator. No automated buy/sell/execute logic. Ever.
- Signal output only.

### Code Hygiene
- Shared swing detection core feeds all modules — do not duplicate logic.
- `//#region` and `//#endregion` for every feature block.
- `input.bool` toggle at top of every major feature.

---

## Source of Truth Hierarchy

1. `indicators/rabid-raccoon.pine` — the canonical indicator
2. This file (AGENTS.md) — rules and operating policy
3. `docs/` — methodology and design notes

---

## MCP Tools (when available)

- **Memory MCP**: search before starting any task
