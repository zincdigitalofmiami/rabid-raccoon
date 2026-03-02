# Report Format

When presenting investigation or diagnostic findings, use this structure:

## 1. Status Summary

One to two sentences. What's working, what's broken, risk level.

## 2. Critical Findings

Each finding must include:

- **What**: The symptom
- **Why**: The root cause with evidence (file path, line, query result)
- **Impact**: What's broken or degraded
- **Fix**: Specific action with risk level (HIGH/MEDIUM/LOW)
- **Effort**: Estimate (quick fix / half day / multi-day)

## 3. Full Diagnostic Table

Every table/system checked, every status, every root cause.
Include expected vs actual for staleness checks.

## 4. Action List

Prioritized: HIGH → MEDIUM → LOW
Each with: what to do, why, risk, effort

## 5. Integrity Statement

List what you did NOT modify and any assumptions you made.
