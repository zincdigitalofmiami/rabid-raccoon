# Warbird Change

1. Read and follow AGENTS.md at the repository root.
2. Search Memory MCP for Warbird, MES, forecasting, and Kirk decisions.
3. Confirm MES is the only prediction target and all other symbols remain features.
4. Inspect impacted training scripts, datasets, and shared libraries before editing.
5. Preserve direct Postgres defaults and do not route bulk writes through Accelerate.
6. Validate that changes respect sequential training constraints and existing governance.
7. Summarize expected model, dataset, and infrastructure effects before implementation.
