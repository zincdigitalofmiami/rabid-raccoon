# Rabid Raccoon — Copilot & Codex Instructions

## 🚨 MANDATORY: Read AGENTS.md Before Acting

`AGENTS.md` is the source of truth for this project. Every suggestion and generated code must be consistent with it.

---

## Project Identity

Multi-feature Pine Script v6 trading indicator for MES futures.
Author: Kirk / ZINC Digital. Signal/indicator only — no execution logic.

---

## Hard Rules

### Pine Script
- **v6 ONLY**. Always `//@version=6`. Never suggest v5 patterns.
- Single indicator file with `//#region` blocks for each feature module.
- Every major feature has an `input.bool` toggle.
- UDTs for structured data (MeasuredMove, FibLevel, RiskProfile, etc.).

### Visualization Language
- Price targets = **horizontal Target Zone lines** — not cones, bands, or funnels.
- BANNED: "cone", "probability cone", "confidence band", "funnel".
- Probability language: "X% probability of this price area".

### Architecture
- Shared swing detection core feeds all modules. Do not duplicate logic.
- Debug mode toggles status dashboard + Pine Logs output.
- Validate in TradingView Pine Editor before committing.

### No Execution Logic
- Indicator output only. Never suggest buy/sell/execute automation.

---

## MCP Tools (when available)
- Memory MCP: search before starting any task
