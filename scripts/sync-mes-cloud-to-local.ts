import { Client } from 'pg'
import { loadDotEnvFiles, parseArg } from './ingest-utils'

type EventColumn = 'eventTime' | 'eventDate'

interface SyncTableConfig {
  table: 'mkt_futures_mes_1m' | 'mkt_futures_mes_15m' | 'mkt_futures_mes_1h' | 'mkt_futures_mes_4h' | 'mkt_futures_mes_1d'
  eventColumn: EventColumn
  overlapMinutes: number
}

interface SyncStats {
  table: string
  fetched: number
  upserted: number
  batches: number
  startedFrom: string | null
  endedAt: string | null
}

const DEFAULT_BATCH_SIZE = 1000
const DEFAULT_TABLES: SyncTableConfig[] = [
  { table: 'mkt_futures_mes_1m', eventColumn: 'eventTime', overlapMinutes: 3 * 24 * 60 },
  { table: 'mkt_futures_mes_15m', eventColumn: 'eventTime', overlapMinutes: 7 * 24 * 60 },
  { table: 'mkt_futures_mes_1h', eventColumn: 'eventTime', overlapMinutes: 14 * 24 * 60 },
  { table: 'mkt_futures_mes_4h', eventColumn: 'eventTime', overlapMinutes: 30 * 24 * 60 },
  { table: 'mkt_futures_mes_1d', eventColumn: 'eventDate', overlapMinutes: 45 * 24 * 60 },
]

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value
  return new Date(String(value))
}

function toIsoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function resolveTables(): SyncTableConfig[] {
  const raw = parseArg('tables', '').trim()
  if (!raw) return DEFAULT_TABLES

  const requested = new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const filtered = DEFAULT_TABLES.filter((cfg) => requested.has(cfg.table))
  if (filtered.length === 0) {
    throw new Error(`No supported tables selected via --tables=${raw}`)
  }
  return filtered
}

async function readCloudMinEvent(cloud: Client, config: SyncTableConfig): Promise<Date | null> {
  const result = await cloud.query<{ minEvent: Date | null }>(
    `
      SELECT MIN("${config.eventColumn}") AS "minEvent"
      FROM "${config.table}"
    `,
  )
  return result.rows[0]?.minEvent ? asDate(result.rows[0].minEvent) : null
}

async function readLocalMaxEvent(local: Client, config: SyncTableConfig): Promise<Date | null> {
  const result = await local.query<{ maxEvent: Date | null }>(
    `
      SELECT MAX("${config.eventColumn}") AS "maxEvent"
      FROM "${config.table}"
    `,
  )
  return result.rows[0]?.maxEvent ? asDate(result.rows[0].maxEvent) : null
}

function startCursorFromWatermark(watermark: Date | null, overlapMinutes: number): Date | null {
  if (!watermark) return null
  return new Date(watermark.getTime() - overlapMinutes * 60 * 1000)
}

async function fetchCloudBatch(
  cloud: Client,
  config: SyncTableConfig,
  cursor: Date,
  batchSize: number,
): Promise<Record<string, unknown>[]> {
  const key = config.eventColumn
  const result = await cloud.query<Record<string, unknown>>(
    `
      SELECT
        "${key}",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "source"::text AS "source",
        "sourceDataset",
        "sourceSchema",
        "rowHash",
        "metadata",
        "ingestedAt",
        "knowledgeTime"
      FROM "${config.table}"
      WHERE "${key}" > $1
      ORDER BY "${key}" ASC
      LIMIT $2
    `,
    [cursor, batchSize],
  )
  return result.rows
}

async function upsertIntradayRows(
  local: Client,
  table: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0
  const dedupedByEventTime = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = asDate(row.eventTime).toISOString()
    dedupedByEventTime.set(key, row)
  }
  const dedupedRows = [...dedupedByEventTime.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((entry) => entry[1])

  const values: unknown[] = []
  const tuples: string[] = []
  for (const row of dedupedRows) {
    const base = values.length
    values.push(
      row.eventTime,
      row.open,
      row.high,
      row.low,
      row.close,
      row.volume,
      row.source,
      row.sourceDataset,
      row.sourceSchema,
      row.rowHash,
      row.metadata ?? null,
      row.ingestedAt,
      row.knowledgeTime,
    )
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::"DataSource", $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`,
    )
  }

  const query = `
    INSERT INTO "${table}" (
      "eventTime", "open", "high", "low", "close", "volume",
      "source", "sourceDataset", "sourceSchema", "rowHash", "metadata",
      "ingestedAt", "knowledgeTime"
    )
    VALUES ${tuples.join(',')}
    ON CONFLICT ("eventTime") DO UPDATE SET
      "open" = EXCLUDED."open",
      "high" = EXCLUDED."high",
      "low" = EXCLUDED."low",
      "close" = EXCLUDED."close",
      "volume" = EXCLUDED."volume",
      "source" = EXCLUDED."source",
      "sourceDataset" = EXCLUDED."sourceDataset",
      "sourceSchema" = EXCLUDED."sourceSchema",
      "rowHash" = EXCLUDED."rowHash",
      "metadata" = EXCLUDED."metadata",
      "ingestedAt" = EXCLUDED."ingestedAt",
      "knowledgeTime" = EXCLUDED."knowledgeTime"
  `

  await local.query(query, values)
  return dedupedRows.length
}

async function upsertDailyRows(local: Client, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0
  const dedupedByEventDate = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = asDate(row.eventDate).toISOString().slice(0, 10)
    dedupedByEventDate.set(key, row)
  }
  const dedupedRows = [...dedupedByEventDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((entry) => entry[1])

  const values: unknown[] = []
  const tuples: string[] = []
  for (const row of dedupedRows) {
    const base = values.length
    values.push(
      row.eventDate,
      row.open,
      row.high,
      row.low,
      row.close,
      row.volume,
      row.source,
      row.sourceDataset,
      row.sourceSchema,
      row.rowHash,
      row.metadata ?? null,
      row.ingestedAt,
      row.knowledgeTime,
    )
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::"DataSource", $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`,
    )
  }

  const query = `
    INSERT INTO "mkt_futures_mes_1d" (
      "eventDate", "open", "high", "low", "close", "volume",
      "source", "sourceDataset", "sourceSchema", "rowHash", "metadata",
      "ingestedAt", "knowledgeTime"
    )
    VALUES ${tuples.join(',')}
    ON CONFLICT ("eventDate") DO UPDATE SET
      "open" = EXCLUDED."open",
      "high" = EXCLUDED."high",
      "low" = EXCLUDED."low",
      "close" = EXCLUDED."close",
      "volume" = EXCLUDED."volume",
      "source" = EXCLUDED."source",
      "sourceDataset" = EXCLUDED."sourceDataset",
      "sourceSchema" = EXCLUDED."sourceSchema",
      "rowHash" = EXCLUDED."rowHash",
      "metadata" = EXCLUDED."metadata",
      "ingestedAt" = EXCLUDED."ingestedAt",
      "knowledgeTime" = EXCLUDED."knowledgeTime"
  `

  await local.query(query, values)
  return dedupedRows.length
}

async function syncTable(
  cloud: Client,
  local: Client,
  config: SyncTableConfig,
  batchSize: number,
): Promise<SyncStats> {
  const localMaxEvent = await readLocalMaxEvent(local, config)
  const overlapCursor = startCursorFromWatermark(localMaxEvent, config.overlapMinutes)
  const cloudMinEvent = overlapCursor ? null : await readCloudMinEvent(cloud, config)
  const initialCursor = overlapCursor ?? (cloudMinEvent ? new Date(cloudMinEvent.getTime() - 1000) : null)

  if (!initialCursor) {
    return {
      table: config.table,
      fetched: 0,
      upserted: 0,
      batches: 0,
      startedFrom: null,
      endedAt: null,
    }
  }

  let cursor = initialCursor
  let fetched = 0
  let upserted = 0
  let batches = 0
  let endedAt: Date | null = null

  for (;;) {
    const rows = await fetchCloudBatch(cloud, config, cursor, batchSize)
    if (rows.length === 0) break

    fetched += rows.length
    batches += 1

    await local.query('BEGIN')
    try {
      if (config.eventColumn === 'eventTime') {
        upserted += await upsertIntradayRows(local, config.table, rows)
      } else {
        upserted += await upsertDailyRows(local, rows)
      }
      await local.query('COMMIT')
    } catch (error) {
      await local.query('ROLLBACK').catch(() => {})
      throw error
    }

    const lastRow = rows[rows.length - 1]
    const lastEvent = asDate(lastRow[config.eventColumn])
    cursor = lastEvent
    endedAt = lastEvent

    if (rows.length < batchSize) break
  }

  return {
    table: config.table,
    fetched,
    upserted,
    batches,
    startedFrom: toIsoOrNull(initialCursor),
    endedAt: toIsoOrNull(endedAt),
  }
}

async function main(): Promise<void> {
  loadDotEnvFiles()

  const cloudReadUrl = requireEnv('MES_SYNC_CLOUD_DATABASE_URL')
  const localWriteUrl = requireEnv('LOCAL_DATABASE_URL')
  if (cloudReadUrl === localWriteUrl) {
    throw new Error('MES_SYNC_CLOUD_DATABASE_URL and LOCAL_DATABASE_URL must be different')
  }

  const batchSize = Math.max(1, Number(parseArg('batch-size', String(DEFAULT_BATCH_SIZE))))
  const tables = resolveTables()

  const cloud = new Client({ connectionString: cloudReadUrl })
  const local = new Client({ connectionString: localWriteUrl })

  await cloud.connect()
  await local.connect()
  try {
    const summaries: SyncStats[] = []
    for (const table of tables) {
      const summary = await syncTable(cloud, local, table, batchSize)
      summaries.push(summary)
      console.log(
        `[mes-sync] table=${summary.table} batches=${summary.batches} fetched=${summary.fetched} upserted=${summary.upserted} start=${summary.startedFrom ?? 'none'} end=${summary.endedAt ?? 'none'}`,
      )
    }

    const totalFetched = summaries.reduce((acc, item) => acc + item.fetched, 0)
    const totalUpserted = summaries.reduce((acc, item) => acc + item.upserted, 0)
    console.log(`[mes-sync] complete tables=${summaries.length} fetched=${totalFetched} upserted=${totalUpserted}`)
  } finally {
    await cloud.end().catch(() => {})
    await local.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error('[mes-sync] failed:', error)
  process.exit(1)
})
