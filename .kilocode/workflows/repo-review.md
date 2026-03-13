# Repo Review

1. Read and follow AGENTS.md at the repository root.
2. Search Memory MCP for rabid-raccoon, Kirk, and task keywords.
3. Identify the impacted domain: dashboard, training models, or shared infrastructure.
4. Inspect affected files before proposing edits.
5. If symbols are involved, use src/lib/symbol-registry/ and do not modify src/lib/symbols.ts or src/lib/ingestion-symbols.ts.
6. If schema is involved, inspect prisma/schema.prisma and relevant migrations, then document impact and rollback before changing anything.
7. Summarize risks, validation steps, and next actions before implementation.
