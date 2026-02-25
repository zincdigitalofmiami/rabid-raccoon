# CLAUDE.md — Rabid Raccoon

Read and follow `AGENTS.md` at the repository root. It is the single source of truth for all AI agents.

Supporting docs: `ARCHITECTURE.md` (system design) · `CONVENTIONS.md` (coding standards).

## Memory MCP (Mandatory)

Before every task, search the Memory MCP for relevant context (keywords from the request + "rabid-raccoon" + "Kirk"). Store any new decisions, corrections, or preferences to memory immediately. See `AGENTS.md` § Memory MCP for full rules.

The Memory MCP server is configured in `.mcp.json` (`mcpServers.memory`). Memory file: `.claude/memory.jsonl`.
