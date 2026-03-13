# Prisma Preflight

1. Read and follow AGENTS.md at the repository root.
2. Search Memory MCP for prior schema, Prisma, or migration decisions.
3. Inspect prisma/schema.prisma and the relevant files under prisma/migrations/.
4. Search the codebase for all references to any table, column, enum, or model you plan to touch.
5. Write down what changes, why it changes, impact, dependencies, and rollback.
6. Treat destructive changes as blocked until explicitly approved.
7. Validate naming, additive migration order, and downstream impact before implementation.
