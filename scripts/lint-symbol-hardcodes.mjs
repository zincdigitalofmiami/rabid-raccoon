#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const BASELINE = resolve(ROOT, 'scripts/lint-baselines/symbol-hardcodes-baseline.txt')

const SYMBOL_LITERAL_PATTERN =
  `['"](MES|ES|NQ|YM|RTY|SOX|VX|DX|DXY|US10Y|ZN|ZB|ZF|ZT|CL|GC|SI|NG|6E|6J|SR3)['"]`
const SYMBOL_CONST_PATTERN =
  'SYMBOL_KEYS|PRIMARY_SYMBOL|ACTIVE_SYMBOLS|INGESTION_SYMBOLS|EXPECTED_SYMBOLS|ANALYSE_SYMBOLS|INVERSE_SYMBOLS|inverseSymbols|CROSS_ASSET_SYMBOLS|expectedSymbols|NON_MES_ACTIVE|NEW_CODES'

const RG_BASE = [
  '-n',
  '--hidden',
  '--glob', '!node_modules',
  '--glob', '!.next',
  '--glob', '!prisma/migrations/**',
  '--glob', '!src/lib/symbol-registry/**',
  '--glob', '!**/*.test.ts',
  '--glob', '!**/*.test.tsx',
  '--glob', '!**/*.spec.ts',
  '--glob', '!**/*.spec.tsx',
  '--glob', '!prisma/seed.ts',
  '--glob', '!*.md',
]

function runRg(pattern) {
  try {
    const output = execFileSync('rg', [...RG_BASE, pattern, 'src', 'scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch (error) {
    if (error && typeof error.status === 'number' && error.status === 1) {
      return []
    }
    throw error
  }
}

const findings = [...runRg(SYMBOL_CONST_PATTERN), ...runRg(SYMBOL_LITERAL_PATTERN)]
const normalized = [...new Set(findings)].sort()

const writeBaseline = process.argv.includes('--write-baseline')
if (writeBaseline) {
  mkdirSync(dirname(BASELINE), { recursive: true })
  writeFileSync(BASELINE, `${normalized.join('\n')}\n`, 'utf8')
  console.log(`[lint:symbol-hardcodes] baseline updated: ${BASELINE} (${normalized.length} entries)`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error(`[lint:symbol-hardcodes] missing baseline: ${BASELINE}`)
  console.error('[lint:symbol-hardcodes] run with --write-baseline once, then commit baseline.')
  process.exit(1)
}

const baseline = readFileSync(BASELINE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

const baselineSet = new Set(baseline)
const added = normalized.filter((line) => !baselineSet.has(line))

if (added.length > 0) {
  console.error(`[lint:symbol-hardcodes] FAIL: ${added.length} new hardcoded symbol references detected`)
  for (const line of added) {
    console.error(line)
  }
  process.exit(1)
}

console.log(
  `[lint:symbol-hardcodes] OK: no new hardcoded symbol references (${normalized.length} tracked baseline entries)`,
)
