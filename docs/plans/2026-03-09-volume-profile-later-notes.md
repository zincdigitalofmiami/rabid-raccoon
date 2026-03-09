# Volume Profile Later Notes

Purpose: hold later-work references for richer volume-profile / orderflow work
without pulling that scope into the current trigger pass.

## Reference shared on 2026-03-09

User-shared context file:

- `/Users/zincdigital/Downloads/CME_MINI_MES1!, 60_946fd.csv`

What was inspected from the export:

- volume-oriented columns only
- visible exported fields included:
  - `Volume`
  - `Volume MA`
  - `VWAP`
  - `Upper Band #1`
  - `Lower Band #1`

Important limitation from this specific CSV:

- the export did not include explicit bid volume, ask volume, footprint cells,
  or delta columns in the visible header rows
- treat it as directional inspiration for volume-profile work, not as a direct
  data-contract example

## Later-work direction

When volume work is resumed, target richer orderflow-style features such as:

- bid/ask split by price level
- footprint-style per-price volume buckets
- delta and cumulative delta
- imbalance / absorption / exhaustion clues
- HVN / LVN style profile structure
- session-context profile levels that can feed trigger acceptance/rejection

## Scope guard

This note is intentionally separate from the current trigger pass.
Do not pull footprint/orderflow implementation into unrelated trigger fixes
without explicit approval.
