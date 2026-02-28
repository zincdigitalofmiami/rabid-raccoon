import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { loadDotEnvFiles } from './ingest-utils'

type CountRow = { table: string; rows: number }

const COUNT_TABLES = [
  'symbols',
  'symbol_mappings',
  'mkt_futures_mes_15m',
  'mkt_futures_mes_1h',
  'mkt_futures_mes_1d',
  'mkt_futures_1h',
  'mkt_futures_1d',
  'econ_rates_1d',
  'econ_yields_1d',
  'econ_fx_1d',
  'econ_activity_1d',
  'econ_indexes_1d',
  'econ_news_1d',
  'policy_news_1d',
  'macro_reports_1d',
  'economic_series',
  'measured_move_signals',
  'ingestion_runs',
  'data_source_registry',
]

function requireEnv(name: 'DIRECT_URL' | 'LOCAL_DATABASE_URL'): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return 'invalid-url'
  }
}

function requireBinary(binary: string): void {
  try {
    execFileSync('bash', ['-lc', `command -v ${binary}`], { stdio: 'ignore' })
  } catch {
    throw new Error(`Required binary not found: ${binary}`)
  }
}

function runCommand(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' })
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function fetchCounts(url: string): Promise<Map<string, number>> {
  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    const out = new Map<string, number>()
    for (const table of COUNT_TABLES) {
      const sql = `SELECT COUNT(*)::bigint AS rows FROM ${quoteIdent(table)}`
      const result = await client.query<{ rows: string }>(sql)
      out.set(table, Number(result.rows[0]?.rows ?? 0))
    }
    return out
  } finally {
    await client.end()
  }
}

async function compareCounts(directUrl: string, localUrl: string): Promise<{ rows: CountRow[]; mismatches: number }> {
  const [direct, local] = await Promise.all([fetchCounts(directUrl), fetchCounts(localUrl)])
  const rows: CountRow[] = []
  let mismatches = 0

  for (const table of COUNT_TABLES) {
    const directRows = direct.get(table) ?? 0
    const localRows = local.get(table) ?? 0
    if (directRows !== localRows) mismatches += 1
    rows.push({
      table,
      rows: localRows,
    })
    console.log(
      `${table.padEnd(28)} direct=${String(directRows).padStart(10)} local=${String(localRows).padStart(10)} ${
        directRows === localRows ? 'OK' : 'MISMATCH'
      }`
    )
  }

  return { rows, mismatches }
}

async function main(): Promise<void> {
  loadDotEnvFiles()

  const directUrl = requireEnv('DIRECT_URL')
  const localUrl = requireEnv('LOCAL_DATABASE_URL')

  requireBinary('pg_dump')
  requireBinary('pg_restore')

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-db-sync-'))
  const dumpPath = path.join(tempDir, 'direct.dump')

  try {
    console.log('[db-sync-local] starting local sync from DIRECT_URL -> LOCAL_DATABASE_URL')
    console.log(`[db-sync-local] source: ${redactUrl(directUrl)}`)
    console.log(`[db-sync-local] target: ${redactUrl(localUrl)}`)
    console.log(`[db-sync-local] dump file: ${dumpPath}`)

    runCommand('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath, directUrl])
    runCommand('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', localUrl, dumpPath])

    console.log('[db-sync-local] comparing exact row counts on key tables')
    const { mismatches } = await compareCounts(directUrl, localUrl)
    if (mismatches > 0) {
      throw new Error(`row-count mismatch detected on ${mismatches} key tables`)
    }

    console.log('[db-sync-local] sync complete and validated')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[db-sync-local] failed: ${message}`)
  process.exitCode = 1
})
