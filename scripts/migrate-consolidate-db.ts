/**
 * One-time migration: copy data from 17d0394... (Production env) → b7eb05c2... (canonical env)
 *
 * The Prisma Platform project rabid-raccoon-db has two environments with cross-wired
 * Accelerate API keys. All Accelerate keys route to b7eb05c2..., but the Production
 * env's direct connection is 17d0394.... This script merges data into the canonical db.
 *
 * Usage:  npx tsx scripts/migrate-consolidate-db.ts [--dry-run]
 */

import pg from 'pg'

// ─── Connection strings ─────────────────────────────────────────────────────

const SOURCE_URL =
  'postgres://17d0394198de7087891c79e14a6530dee86ff0690b489dfccda2402a84083287:sk_qnk9qi_fik0Yl0b32Y4-Q@db.prisma.io:5432/postgres?sslmode=require'

const TARGET_URL =
  'postgres://b7eb05c2a57066639ef8cd3c90d060113c46ccac883ff5cd139ed946870efba9:sk_Cb-PGKW0E93OIAoIOnqmN@db.prisma.io:5432/postgres?sslmode=require'

const DRY_RUN = process.argv.includes('--dry-run')

// ─── Table definitions ──────────────────────────────────────────────────────

interface TableDef {
  name: string
  /** Columns that form the unique/pk constraint for ON CONFLICT */
  conflictCols: string[]
  /** All columns to copy (excluding autoincrement id) */
  dataCols: string[]
}

const ECON_DATA_COLS = [
  '"seriesId"', '"eventDate"', 'value', 'source',
  '"ingestedAt"', '"knowledgeTime"', '"rowHash"', 'metadata',
]

const ECON_TABLES: TableDef[] = [
  'econ_rates_1d', 'econ_yields_1d', 'econ_fx_1d', 'econ_vol_indices_1d',
  'econ_inflation_1d', 'econ_labor_1d', 'econ_activity_1d', 'econ_money_1d',
  'econ_commodities_1d', 'econ_indexes_1d',
].map(name => ({
  name,
  conflictCols: ['"seriesId"', '"eventDate"'],
  dataCols: ECON_DATA_COLS,
}))

const ECONOMIC_SERIES: TableDef = {
  name: 'economic_series',
  conflictCols: ['"seriesId"'],
  dataCols: [
    '"seriesId"', '"displayName"', 'category', 'source', '"sourceSymbol"',
    'frequency', 'units', '"isActive"', 'metadata', '"createdAt"', '"updatedAt"',
  ],
}

const DATA_SOURCE_REGISTRY: TableDef = {
  name: 'data_source_registry',
  conflictCols: ['"sourceId"'],
  dataCols: [
    '"sourceId"', '"sourceName"', 'description', '"targetTable"', '"apiProvider"',
    '"updateFrequency"', '"authEnvVar"', '"ingestionScript"', '"isActive"',
    '"createdAt"', '"updatedAt"',
  ],
}

const INGESTION_RUNS: TableDef = {
  name: 'ingestion_runs',
  conflictCols: ['id'],  // PK — use id to avoid true dupes, but ids will differ
  dataCols: [
    'job', '"startedAt"', '"finishedAt"', 'status',
    '"rowsProcessed"', '"rowsInserted"', '"rowsFailed"', 'details',
  ],
}

const MKT_FUTURES_1D: TableDef = {
  name: 'mkt_futures_1d',
  conflictCols: ['"symbolCode"', '"eventDate"'],
  dataCols: [
    '"symbolCode"', '"eventDate"', 'open', 'high', 'low', 'close',
    'volume', '"openInterest"', 'source', '"sourceDataset"', '"sourceSchema"',
    '"ingestedAt"', '"knowledgeTime"', '"rowHash"', 'metadata',
  ],
}

const MKT_FUTURES_1H: TableDef = {
  name: 'mkt_futures_1h',
  conflictCols: ['"symbolCode"', '"eventTime"'],
  dataCols: [
    '"symbolCode"', '"eventTime"', 'open', 'high', 'low', 'close',
    'volume', '"openInterest"', 'source', '"sourceDataset"', '"sourceSchema"',
    '"ingestedAt"', '"knowledgeTime"', '"rowHash"', 'metadata',
  ],
}

const MKT_FUTURES_MES_15M: TableDef = {
  name: 'mkt_futures_mes_15m',
  conflictCols: ['"symbolCode"', '"eventTime"'],
  dataCols: [
    '"symbolCode"', '"eventTime"', 'open', 'high', 'low', 'close',
    'volume', '"openInterest"', 'source', '"sourceDataset"', '"sourceSchema"',
    '"ingestedAt"', '"knowledgeTime"', '"rowHash"', 'metadata',
  ],
}

const MKT_FUTURES_MES_1H: TableDef = {
  name: 'mkt_futures_mes_1h',
  conflictCols: ['"symbolCode"', '"eventTime"'],
  dataCols: [
    '"symbolCode"', '"eventTime"', 'open', 'high', 'low', 'close',
    'volume', '"openInterest"', 'source', '"sourceDataset"', '"sourceSchema"',
    '"ingestedAt"', '"knowledgeTime"', '"rowHash"', 'metadata',
  ],
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function countRows(pool: pg.Pool, table: string): Promise<number> {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${table}"`)
    return rows[0].n
  } catch {
    return -1  // table doesn't exist
  }
}

async function migrateTable(
  source: pg.Pool,
  target: pg.Pool,
  def: TableDef,
): Promise<number> {
  const cols = def.dataCols.join(', ')
  const conflict = def.conflictCols.join(', ')
  const BATCH = 500
  let offset = 0
  let totalInserted = 0

  while (true) {
    const { rows } = await source.query(
      `SELECT ${cols} FROM "${def.name}" ORDER BY 1, 2 LIMIT ${BATCH} OFFSET ${offset}`
    )
    if (rows.length === 0) break

    if (!DRY_RUN) {
      // Build a multi-row INSERT
      const values: unknown[] = []
      const placeholders: string[] = []
      const numCols = def.dataCols.length

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const paramRefs: string[] = []
        for (let j = 0; j < numCols; j++) {
          const colName = def.dataCols[j].replace(/"/g, '')
          values.push(row[colName])
          paramRefs.push(`$${i * numCols + j + 1}`)
        }
        // Handle jsonb columns
        const jsonCols = ['metadata', 'details', 'features', 'scoreBreakdown']
        const withCasts = paramRefs.map((ref, j) => {
          const col = def.dataCols[j].replace(/"/g, '')
          return jsonCols.includes(col) ? `${ref}::jsonb` : ref
        })
        placeholders.push(`(${withCasts.join(', ')})`)
      }

      const result = await target.query(
        `INSERT INTO "${def.name}" (${cols})
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (${conflict}) DO NOTHING`,
        values
      )
      totalInserted += result.rowCount ?? 0
    } else {
      totalInserted += rows.length
    }

    offset += rows.length
    if (rows.length < BATCH) break
  }

  return totalInserted
}

// ─── Special: ingestion_runs (skip id, let target auto-assign) ──────────────

async function migrateIngestionRuns(
  source: pg.Pool,
  target: pg.Pool,
): Promise<number> {
  const cols = INGESTION_RUNS.dataCols.join(', ')
  const { rows } = await source.query(
    `SELECT ${cols} FROM "ingestion_runs" ORDER BY "startedAt"`
  )
  if (rows.length === 0) return 0
  if (DRY_RUN) return rows.length

  let inserted = 0
  for (const row of rows) {
    // Check if an identical run already exists (same job + startedAt)
    const existing = await target.query(
      `SELECT 1 FROM "ingestion_runs" WHERE job = $1 AND "startedAt" = $2 LIMIT 1`,
      [row.job, row.startedAt]
    )
    if (existing.rows.length > 0) continue

    const values = INGESTION_RUNS.dataCols.map(c => row[c.replace(/"/g, '')])
    const params = values.map((_, i) => `$${i + 1}`)
    // Cast details as jsonb
    const detailsIdx = INGESTION_RUNS.dataCols.indexOf('details')
    if (detailsIdx >= 0) params[detailsIdx] = `$${detailsIdx + 1}::jsonb`

    await target.query(
      `INSERT INTO "ingestion_runs" (${cols}) VALUES (${params.join(', ')})`,
      values
    )
    inserted++
  }
  return inserted
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE MIGRATION ===')
  console.log('Source: 17d0394... (Production env)')
  console.log('Target: b7eb05c2... (canonical / Accelerate env)\n')

  const source = new pg.Pool({ connectionString: SOURCE_URL, max: 2 })
  const target = new pg.Pool({ connectionString: TARGET_URL, max: 2 })

  // Verify connectivity
  await source.query('SELECT 1')
  console.log('Source connected.')
  await target.query('SELECT 1')
  console.log('Target connected.\n')

  // ─── Before counts ──────────────────────────────────────────────────────

  const allTables: TableDef[] = [
    ECONOMIC_SERIES,
    ...ECON_TABLES,
    DATA_SOURCE_REGISTRY,
    INGESTION_RUNS,
    MKT_FUTURES_1D,
    MKT_FUTURES_1H,
    MKT_FUTURES_MES_15M,
    MKT_FUTURES_MES_1H,
  ]

  console.log('─── BEFORE counts ───')
  console.log(`${'Table'.padEnd(30)} ${'Source'.padStart(10)} ${'Target'.padStart(10)}`)
  for (const t of allTables) {
    const sc = await countRows(source, t.name)
    const tc = await countRows(target, t.name)
    const flag = sc > tc ? ' ◀' : ''
    console.log(`${t.name.padEnd(30)} ${String(sc).padStart(10)} ${String(tc).padStart(10)}${flag}`)
  }
  console.log()

  // ─── Migrate ────────────────────────────────────────────────────────────

  // 1. economic_series first (FK parent)
  console.log('Migrating economic_series...')
  const seriesCount = await migrateTable(source, target, ECONOMIC_SERIES)
  console.log(`  → ${seriesCount} rows ${DRY_RUN ? 'would be' : ''} inserted\n`)

  // 2. All econ domain tables
  for (const t of ECON_TABLES) {
    console.log(`Migrating ${t.name}...`)
    const count = await migrateTable(source, target, t)
    console.log(`  → ${count} rows ${DRY_RUN ? 'would be' : ''} inserted`)
  }
  console.log()

  // 3. data_source_registry
  console.log('Migrating data_source_registry...')
  const dsrCount = await migrateTable(source, target, DATA_SOURCE_REGISTRY)
  console.log(`  → ${dsrCount} rows ${DRY_RUN ? 'would be' : ''} inserted\n`)

  // 4. ingestion_runs (special handling — no fixed conflict key across dbs)
  console.log('Migrating ingestion_runs...')
  const irCount = await migrateIngestionRuns(source, target)
  console.log(`  → ${irCount} rows ${DRY_RUN ? 'would be' : ''} inserted\n`)

  // 5. Market data tables — only migrate if source has more than target
  for (const t of [MKT_FUTURES_1D, MKT_FUTURES_1H, MKT_FUTURES_MES_15M, MKT_FUTURES_MES_1H]) {
    const sc = await countRows(source, t.name)
    const tc = await countRows(target, t.name)
    if (sc <= 0 || tc >= sc) {
      console.log(`Skipping ${t.name} (target ${tc} >= source ${sc})`)
      continue
    }
    console.log(`Migrating ${t.name}...`)
    const count = await migrateTable(source, target, t)
    console.log(`  → ${count} rows ${DRY_RUN ? 'would be' : ''} inserted`)
  }
  console.log()

  // ─── After counts ─────────────────────────────────────────────────────

  console.log('─── AFTER counts ───')
  console.log(`${'Table'.padEnd(30)} ${'Source'.padStart(10)} ${'Target'.padStart(10)}`)
  for (const t of allTables) {
    const sc = await countRows(source, t.name)
    const tc = await countRows(target, t.name)
    const match = sc === tc ? ' ✓' : sc > tc ? ' ✗' : ''
    console.log(`${t.name.padEnd(30)} ${String(sc).padStart(10)} ${String(tc).padStart(10)}${match}`)
  }

  await source.end()
  await target.end()
  console.log('\nDone.')
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
