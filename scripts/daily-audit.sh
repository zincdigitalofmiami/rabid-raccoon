#!/bin/bash
# ============================================================
# Rabid Raccoon — Daily Read-Only Audit
# Runs: code quality, dependency security, deep scan review
# All read-only — never modifies code or state
# ============================================================

set -euo pipefail

PROJECT_DIR="/Users/zincdigital/Projects/rabid-raccoon"
REPORT_DIR="$PROJECT_DIR/.audit-reports"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M")
REPORT="$REPORT_DIR/audit-$TIMESTAMP.txt"

mkdir -p "$REPORT_DIR"

cd "$PROJECT_DIR"

# Header
{
  echo "============================================================"
  echo "  RABID RACCOON — DAILY AUDIT REPORT"
  echo "  Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "  Branch: $(git branch --show-current)"
  echo "  Commit: $(git log -1 --format='%h %s')"
  echo "============================================================"
  echo ""
} > "$REPORT"

# Track overall status
FAILURES=0

# ── Phase 1: Code Quality Audit ──────────────────────────────
{
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  PHASE 1: CODE QUALITY AUDIT                           ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
} >> "$REPORT"

# ESLint
echo "[$(date +%H:%M:%S)] Running ESLint..." >> "$REPORT"
if npx next lint --no-cache 2>&1 >> "$REPORT"; then
  echo "  ✓ ESLint: PASS" >> "$REPORT"
else
  echo "  ✗ ESLint: ISSUES FOUND" >> "$REPORT"
  FAILURES=$((FAILURES + 1))
fi
echo "" >> "$REPORT"

# TypeScript type check
echo "[$(date +%H:%M:%S)] Running TypeScript type check..." >> "$REPORT"
if npx tsc --noEmit 2>&1 >> "$REPORT"; then
  echo "  ✓ TypeScript: PASS" >> "$REPORT"
else
  echo "  ✗ TypeScript: TYPE ERRORS FOUND" >> "$REPORT"
  FAILURES=$((FAILURES + 1))
fi
echo "" >> "$REPORT"

# ── Phase 2: Dependency Security Audit ────────────────────────
{
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  PHASE 2: DEPENDENCY SECURITY AUDIT                    ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
} >> "$REPORT"

# npm audit
echo "[$(date +%H:%M:%S)] Running npm audit..." >> "$REPORT"
if npm audit --omit=dev 2>&1 >> "$REPORT"; then
  echo "  ✓ npm audit (production): CLEAN" >> "$REPORT"
else
  echo "  ✗ npm audit (production): VULNERABILITIES FOUND" >> "$REPORT"
  FAILURES=$((FAILURES + 1))
fi
echo "" >> "$REPORT"

# Full audit including dev
echo "[$(date +%H:%M:%S)] Running npm audit (all deps)..." >> "$REPORT"
if npm audit 2>&1 >> "$REPORT"; then
  echo "  ✓ npm audit (all): CLEAN" >> "$REPORT"
else
  echo "  ✗ npm audit (all): VULNERABILITIES FOUND" >> "$REPORT"
  FAILURES=$((FAILURES + 1))
fi
echo "" >> "$REPORT"

# Outdated packages
echo "[$(date +%H:%M:%S)] Checking outdated packages..." >> "$REPORT"
npm outdated 2>&1 >> "$REPORT" || true
echo "" >> "$REPORT"

# ── Phase 3: Deep Scan Code Review ───────────────────────────
{
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  PHASE 3: DEEP SCAN CODE REVIEW (cubic)                ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
} >> "$REPORT"

echo "[$(date +%H:%M:%S)] Running cubic review (headless)..." >> "$REPORT"
if cubic review 2>&1 >> "$REPORT"; then
  echo "  ✓ cubic review: COMPLETE" >> "$REPORT"
else
  echo "  ✗ cubic review: ISSUES FOUND OR FAILED" >> "$REPORT"
  FAILURES=$((FAILURES + 1))
fi
echo "" >> "$REPORT"

# ── Summary ───────────────────────────────────────────────────
{
  echo "============================================================"
  echo "  SUMMARY"
  echo "============================================================"
  if [ "$FAILURES" -eq 0 ]; then
    echo "  ✓ ALL CHECKS PASSED"
  else
    echo "  ✗ $FAILURES CHECK(S) HAD ISSUES — review report above"
  fi
  echo "  Report saved: $REPORT"
  echo "  Completed: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "============================================================"
} >> "$REPORT"

# Keep only last 30 reports
ls -t "$REPORT_DIR"/audit-*.txt 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

echo "Audit complete. Report: $REPORT"
