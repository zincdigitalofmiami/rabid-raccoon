t# Safety Constraints

## Database Rules

- NEVER modify .env, .env.local, .env.production, or connection strings
- NEVER run prisma migrate, db push, db pull, or schema-altering commands
- NEVER INSERT, UPDATE, DELETE, DROP, ALTER, or TRUNCATE
- SELECT only, and show the query before running it
- If you discover a genuine database mismatch, STOP and report. Don't fix it.

## Code Rules

- NEVER modify files without explicit approval for the specific change
- NEVER auto-approve your own changes — present diffs and wait
- State what you're about to do BEFORE doing it
- If something seems wrong with the architecture, ASK before "fixing"

## Investigation Rules

- Read-only by default for all investigations
- Report findings; Kirk decides what to change
- Don't conflate Prisma Accelerate tenant IDs with database mismatches
- Don't alarm on expected staleness (monthly/quarterly FRED data)
