# Investigation Orchestrator Protocol

When asked to investigate, diagnose, or audit any system, follow this
EXACT phased approach. Do NOT skip phases. Do NOT jump to conclusions.

## PHASE 1: UNDERSTAND (Read-Only)

Before touching anything:

1. Read ALL relevant config files (schema.prisma, .env patterns, package.json)
2. Read AGENTS.md and any project documentation
3. Map the architecture — what connects to what
4. Identify your assumptions and STATE THEM before proceeding
5. Ask: "What could I be wrong about?"

## PHASE 2: MAP (Cross-Reference)

For data staleness issues:

1. Map every Inngest function → its target table
2. Map every table → its upstream data source
3. Check publication frequencies (daily vs weekly vs monthly vs quarterly)
4. Cross-reference: is staleness because of JOB FAILURE or SOURCE LAG?
5. Check the symbol registry — are all referenced symbols in the correct role?

For code issues:

1. Trace the full execution path, not just the file with the bug
2. Check what calls this function, what this function calls
3. Verify assumptions against actual database state
4. Look for registry/config mismatches (code says X, config says Y)

## PHASE 3: DIAGNOSE (Root Cause, Not Symptoms)

For each finding:

1. State the SYMPTOM (what you observed)
2. State the ROOT CAUSE (why it's happening)
3. State the EVIDENCE (specific file, line, query, or config)
4. State the IMPACT (what's broken because of this)
5. State the FIX (specific, actionable, with risk level)

Do NOT say "likely failing" — investigate until you KNOW.
Do NOT say "check the dashboard" — that's punting. Find the evidence yourself.

## PHASE 4: REPORT (Structured Output)

Present findings in this exact format:

- Status summary (1-2 sentences)
- Critical findings (with evidence chain)
- Full diagnostic table (every table, every status, every root cause)
- Prioritized action list (HIGH/MEDIUM/LOW with risk levels)
- "Things I did NOT change" section

## PHASE 5: VERIFY YOUR OWN WORK

Before presenting your report:

1. Re-read your findings — are any based on assumptions you didn't verify?
2. Did you check publication schedules before calling something "stale"?
3. Did you check the symbol registry before blaming a function?
4. Did you differentiate between "job failing" and "no job exists"?
5. Remove any finding you cannot back with specific evidence.
