import { createHash } from 'node:crypto'
import { Prisma, DataSource, EconCategory } from '@prisma/client'
import { Client } from 'pg'
import { prisma } from '../src/lib/prisma'

type PgRow = Record<string, unknown>

type ImportSection =
  | 'rates'
  | 'vol_indices'
  | 'inflation'
  | 'labor'
  | 'activity'
  | 'money'
  | 'commodities'
  | 'fx_spot'
  | 'indexes'
  | 'econ_news'
  | 'policy_news'
  | 'series'

const ALL_SECTIONS: ImportSection[] = [
  'rates',
  'vol_indices',
  'inflation',
  'labor',
  'activity',
  'money',
  'commodities',
  'fx_spot',
  'indexes',
  'econ_news',
  'policy_news',
  'series',
]

const CHUNK_SIZE = Number(process.env.FUSION_IMPORT_CHUNK_SIZE ?? 1_000)
const WRITE_BATCH_SIZE = Number(process.env.FUSION_IMPORT_WRITE_BATCH_SIZE ?? 300)
const OP_TIMEOUT_MS = Number(process.env.FUSION_IMPORT_OP_TIMEOUT_MS ?? 45_000)
const SECTION_FILTER = resolveSections(process.env.FUSION_IMPORT_SECTIONS)

if (!Number.isFinite(CHUNK_SIZE) || CHUNK_SIZE <= 0) {
  throw new Error(`Invalid FUSION_IMPORT_CHUNK_SIZE: ${process.env.FUSION_IMPORT_CHUNK_SIZE ?? 'undefined'}`)
}

if (!Number.isFinite(WRITE_BATCH_SIZE) || WRITE_BATCH_SIZE <= 0) {
  throw new Error(`Invalid FUSION_IMPORT_WRITE_BATCH_SIZE: ${process.env.FUSION_IMPORT_WRITE_BATCH_SIZE ?? 'undefined'}`)
}

if (!Number.isFinite(OP_TIMEOUT_MS) || OP_TIMEOUT_MS <= 0) {
  throw new Error(`Invalid FUSION_IMPORT_OP_TIMEOUT_MS: ${process.env.FUSION_IMPORT_OP_TIMEOUT_MS ?? 'undefined'}`)
}

function resolveSections(raw: string | undefined): Set<ImportSection> {
  if (!raw || raw.trim() === '' || raw.trim().toLowerCase() === 'all') {
    return new Set(ALL_SECTIONS)
  }

  const selected = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean) as ImportSection[]

  const unknown = selected.filter((token) => !ALL_SECTIONS.includes(token))
  if (unknown.length > 0) {
    throw new Error(`Unsupported FUSION_IMPORT_SECTIONS value(s): ${unknown.join(', ')}`)
  }

  return new Set(selected)
}

function shouldImport(section: ImportSection): boolean {
  return SECTION_FILTER.has(section)
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function ensureArrayStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((v) => v.replace(/^"(.*)"$/, '$1').trim())
        .filter((v) => v.length > 0)
    }
    return [trimmed]
  }
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0)
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
  }
  if (typeof value === 'string') {
    return new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  }
  throw new Error(`Invalid date value: ${String(value)}`)
}

function normalizeTimestamp(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value === 'string') return new Date(value)
  return null
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s.length ? s : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const s = safeString(value)
    if (s) return s
  }
  return null
}

function requireFusionUrl(): string {
  const url = process.env.FUSION_DATABASE_URL
  if (!url) throw new Error('FUSION_DATABASE_URL is required')
  return url
}

function hashSeries(seriesId: string, eventDate: Date, value: number, source: string): string {
  return createHash('sha256')
    .update(`${seriesId}|${eventDate.toISOString().slice(0, 10)}|${value}|${source}`)
    .digest('hex')
}

function hashNews(sourceTable: string, articleId: string | null, eventDate: Date, headline: string): string {
  return createHash('sha256')
    .update(`${sourceTable}|${articleId || ''}|${eventDate.toISOString().slice(0, 10)}|${headline}`)
    .digest('hex')
}

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${OP_TIMEOUT_MS}ms`))
        }, OP_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      const result = await withTimeout(label, fn())
      return result
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (i === attempts) break
      const delayMs = Math.min(1000 * 2 ** (i - 1), 15_000)
      console.warn(`[fusion-econ] retry ${i}/${attempts} for ${label}: ${message}`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

async function createManyBatched<T>(
  label: string,
  data: T[],
  writer: (batch: T[]) => Promise<number>,
  batchSize = WRITE_BATCH_SIZE
): Promise<number> {
  let inserted = 0
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize)
    inserted += await withRetry(`${label} batch ${Math.floor(i / batchSize) + 1}`, () => writer(batch))
  }
  return inserted
}

function isYieldSeries(seriesId: string): boolean {
  const s = seriesId.toUpperCase()
  return /^DGS\d+/.test(s) || /^DFII\d+/.test(s) || /^GS\d+/.test(s) || /^T\d+Y(IE|M)$/.test(s)
}

function isFxSeries(seriesId: string): boolean {
  const s = seriesId.toUpperCase()
  return /^DTWEX/.test(s) || /^DEX[A-Z]{3}/.test(s) || /^EX[A-Z]{6}/.test(s)
}

const tableColumnCache = new Map<string, Set<string>>()

async function getTableColumns(source: Client, fullTable: string): Promise<Set<string>> {
  if (tableColumnCache.has(fullTable)) return tableColumnCache.get(fullTable)!
  const [schema, table] = fullTable.split('.')
  const result = await withRetry(`${fullTable} column introspection`, () =>
    withTimeout(
      `${fullTable} column introspection`,
      source.query(
        `
          select column_name
          from information_schema.columns
          where table_schema = $1
            and table_name = $2
          order by ordinal_position
        `,
        [schema, table]
      )
    )
  )
  const columns = new Set<string>(result.rows.map((row) => String(row.column_name)))
  tableColumnCache.set(fullTable, columns)
  return columns
}

async function fetchChunk(source: Client, fullTable: string, columns: string[] | undefined, lastId: number): Promise<PgRow[]> {
  const selectClause = columns?.length ? columns.join(', ') : '*'
  const sql = `
    select ${selectClause}
    from ${fullTable}
    where id > $1
    order by id asc
    limit ${CHUNK_SIZE}
  `
  const result = await source.query(sql, [lastId])
  return result.rows
}

async function fetchChunkWithRetry(
  source: Client,
  fullTable: string,
  columns: string[] | undefined,
  lastId: number
): Promise<PgRow[]> {
  return withRetry(`${fullTable} fetch id>${lastId}`, () => fetchChunk(source, fullTable, columns, lastId))
}

async function importRatesDomain(source: Client): Promise<{ processed: number; inserted: number }> {
  let processed = 0
  let inserted = 0
  let lastId = 0

  while (true) {
    const rows = await fetchChunkWithRetry(
      source,
      'econ.rates_1d',
      ['id', 'series_id', 'event_date', 'value', 'source', 'row_hash'],
      lastId
    )
    if (rows.length === 0) break
    lastId = Number(rows[rows.length - 1].id)

    const rateRows: Prisma.EconRates1dCreateManyInput[] = []
    const yieldRows: Prisma.EconYields1dCreateManyInput[] = []
    const fxRows: Prisma.EconFx1dCreateManyInput[] = []

    for (const row of rows) {
      const seriesId = String(row.series_id)
      const value = Number(row.value)
      if (!Number.isFinite(value)) continue
      const eventDate = normalizeDate(row.event_date)
      const sourceName = safeString(row.source) || 'FRED'
      const rowHash = safeString(row.row_hash) || hashSeries(seriesId, eventDate, value, sourceName)
      const common = {
        seriesId,
        eventDate,
        value,
        source: DataSource.FRED,
        rowHash,
        metadata: toJson({ importedFrom: 'fusion.econ.rates_1d' }),
      }

      if (isFxSeries(seriesId)) {
        fxRows.push(common)
      } else if (isYieldSeries(seriesId)) {
        yieldRows.push(common)
      } else {
        rateRows.push(common)
      }
    }

    processed += rows.length
    if (rateRows.length) {
      inserted += await createManyBatched('econRates1d', rateRows, async (batch) =>
        (await prisma.econRates1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
    if (yieldRows.length) {
      inserted += await createManyBatched('econYields1d', yieldRows, async (batch) =>
        (await prisma.econYields1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
    if (fxRows.length) {
      inserted += await createManyBatched('econFx1d', fxRows, async (batch) =>
        (await prisma.econFx1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
  }

  return { processed, inserted }
}

async function importSimpleSeriesDomain(
  source: Client,
  fullTable: string,
  category: 'VOLATILITY' | 'INFLATION' | 'LABOR' | 'ACTIVITY' | 'MONEY' | 'COMMODITIES'
): Promise<{ processed: number; inserted: number }> {
  let processed = 0
  let inserted = 0
  let lastId = 0

  while (true) {
    const rows = await fetchChunkWithRetry(
      source,
      fullTable,
      ['id', 'series_id', 'event_date', 'value', 'source', 'row_hash'],
      lastId
    )
    if (rows.length === 0) break
    lastId = Number(rows[rows.length - 1].id)

    const data = rows
      .filter((row) => Number.isFinite(Number(row.value)))
      .map((row) => {
        const seriesId = String(row.series_id)
        const eventDate = normalizeDate(row.event_date)
        const value = Number(row.value)
        const sourceName = safeString(row.source) || 'FRED'
        const rowHash = safeString(row.row_hash) || hashSeries(seriesId, eventDate, value, sourceName)

        return {
          seriesId,
          eventDate,
          value,
          source: DataSource.FRED,
          rowHash,
          metadata: toJson({ importedFrom: fullTable }),
        }
      })

    processed += rows.length
    if (data.length === 0) continue

    if (category === 'VOLATILITY') {
      inserted += await createManyBatched('econVolIndices1d', data, async (batch) =>
        (await prisma.econVolIndices1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    } else if (category === 'INFLATION') {
      inserted += await createManyBatched('econInflation1d', data, async (batch) =>
        (await prisma.econInflation1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    } else if (category === 'LABOR') {
      inserted += await createManyBatched('econLabor1d', data, async (batch) =>
        (await prisma.econLabor1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    } else if (category === 'ACTIVITY') {
      inserted += await createManyBatched('econActivity1d', data, async (batch) =>
        (await prisma.econActivity1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    } else if (category === 'MONEY') {
      inserted += await createManyBatched('econMoney1d', data, async (batch) =>
        (await prisma.econMoney1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    } else if (category === 'COMMODITIES') {
      inserted += await createManyBatched('econCommodities1d', data, async (batch) =>
        (await prisma.econCommodities1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
  }

  return { processed, inserted }
}

async function importFxSpot(source: Client): Promise<{ processed: number; inserted: number }> {
  let processed = 0
  let inserted = 0
  let lastId = 0

  while (true) {
    const rows = await fetchChunkWithRetry(
      source,
      'mkt.fx_1d',
      ['id', 'pair', 'event_date', 'rate', 'source', 'row_hash'],
      lastId
    )
    if (rows.length === 0) break
    lastId = Number(rows[rows.length - 1].id)

    const data: Prisma.MktIndexes1dCreateManyInput[] = rows
      .filter((row) => Number.isFinite(Number(row.rate)))
      .map((row) => ({
        symbolCode: String(row.pair),
        eventDate: normalizeDate(row.event_date),
        open: Number(row.rate),
        high: Number(row.rate),
        low: Number(row.rate),
        close: Number(row.rate),
        volume: BigInt(0),
        source: DataSource.INTERNAL,
        sourceSymbol: safeString(row.pair),
        rowHash: safeString(row.row_hash) || null,
        metadata: toJson({ importedFrom: 'fusion.mkt.fx_1d', source: safeString(row.source) }),
      }))

    processed += rows.length
    if (data.length > 0) {
      inserted += await createManyBatched('mktIndexes1d', data, async (batch) =>
        (await prisma.mktIndexes1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
  }

  return { processed, inserted }
}

async function importEtfIndexes(source: Client): Promise<{ processed: number; inserted: number }> {
  let processed = 0
  let inserted = 0
  let lastId = 0

  while (true) {
    const rows = await fetchChunkWithRetry(
      source,
      'mkt.etf_1d',
      ['id', 'symbol', 'event_date', 'open', 'high', 'low', 'close', 'volume', 'source', 'row_hash'],
      lastId
    )
    if (rows.length === 0) break
    lastId = Number(rows[rows.length - 1].id)

    const data: Prisma.MktIndexes1dCreateManyInput[] = rows.map((row) => ({
      symbolCode: String(row.symbol),
      eventDate: normalizeDate(row.event_date),
      open: Number.isFinite(Number(row.open)) ? Number(row.open) : null,
      high: Number.isFinite(Number(row.high)) ? Number(row.high) : null,
      low: Number.isFinite(Number(row.low)) ? Number(row.low) : null,
      close: Number.isFinite(Number(row.close)) ? Number(row.close) : null,
      volume: Number.isFinite(Number(row.volume)) ? BigInt(String(row.volume)) : null,
      source: DataSource.YAHOO,
      sourceSymbol: String(row.symbol),
      rowHash: safeString(row.row_hash) || null,
      metadata: toJson({ importedFrom: 'fusion.mkt.etf_1d', source: safeString(row.source) }),
    }))

    processed += rows.length
    if (data.length > 0) {
      inserted += await createManyBatched('mktIndexes1d', data, async (batch) =>
        (await prisma.mktIndexes1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
  }

  return { processed, inserted }
}

async function importEconNewsTable(source: Client, fullTable: string): Promise<{ processed: number; inserted: number }> {
  let processed = 0
  let inserted = 0
  let lastId = 0
  const columns = await getTableColumns(source, fullTable)

  while (true) {
    const rows = await fetchChunkWithRetry(source, fullTable, undefined, lastId)
    if (rows.length === 0) break
    lastId = Number(rows[rows.length - 1].id)

    const data: Prisma.EconNews1dCreateManyInput[] = []

    for (const row of rows) {
      const headline = firstString(row.headline, columns.has('title') ? row.title : null)
      const eventDate = row.event_date ? normalizeDate(row.event_date) : null
      if (!headline || !eventDate) continue
      const articleId = safeString(row.article_id)
      const rowHash =
        safeString(row.row_hash) ||
        hashNews(fullTable, articleId, eventDate, headline)

      const topics = Array.from(
        new Set([
          ...ensureArrayStrings(row.topics),
          ...ensureArrayStrings(row.categories),
          ...ensureArrayStrings(row.keywords),
        ])
      )
      const subjects = Array.from(
        new Set([
          ...ensureArrayStrings(row.subjects),
          ...ensureArrayStrings(row.subject),
        ])
      )

      const tags = Array.from(
        new Set([
          ...ensureArrayStrings(row.specialist_tags),
          ...ensureArrayStrings(row.tags),
          ...topics,
          ...subjects,
          ...ensureArrayStrings(row.section),
          `source_table:${fullTable}`,
        ])
      )

      const summary = firstString(row.summary, row.meta_description)
      const content = firstString(row.content, summary)

      data.push({
        articleId,
        eventDate,
        publishedAt: normalizeTimestamp(row.published_at),
        headline,
        summary: summary || content,
        content,
        source: safeString(row.source),
        author: safeString(row.author),
        url: safeString(row.url),
        sentimentLabel: safeString(row.zl_sentiment),
        topics,
        subjects,
        tags,
        rowHash,
        rawPayload: row.raw_payload ? toJson(row.raw_payload) : toJson({ importedFrom: fullTable }),
      })
    }

    processed += rows.length
    if (data.length > 0) {
      inserted += await createManyBatched('econNews1d', data, async (batch) =>
        (await prisma.econNews1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
  }

  return { processed, inserted }
}

async function importPolicyNewsTable(source: Client, fullTable: string): Promise<{ processed: number; inserted: number }> {
  let processed = 0
  let inserted = 0
  let lastId = 0
  const columns = await getTableColumns(source, fullTable)

  while (true) {
    const rows = await fetchChunkWithRetry(source, fullTable, undefined, lastId)
    if (rows.length === 0) break
    lastId = Number(rows[rows.length - 1].id)

    const data: Prisma.PolicyNews1dCreateManyInput[] = []

    for (const row of rows) {
      const headline = firstString(row.headline, columns.has('title') ? row.title : null)
      const eventDate = row.event_date ? normalizeDate(row.event_date) : null
      if (!headline || !eventDate) continue

      const articleId = safeString(row.article_id)
      const rowHash =
        safeString(row.row_hash) ||
        hashNews(fullTable, articleId, eventDate, headline)

      const tags = Array.from(
        new Set([
          ...ensureArrayStrings(row.specialist_tags),
          ...ensureArrayStrings(row.topics),
          ...ensureArrayStrings(row.subjects),
          ...ensureArrayStrings(row.action),
          ...ensureArrayStrings(row.document_type),
          ...ensureArrayStrings(row.agency),
          `source_table:${fullTable}`,
        ])
      )

      const summary = firstString(
        row.summary,
        row.content,
        columns.has('action') ? row.action : null,
        columns.has('document_type') ? row.document_type : null
      )

      data.push({
        eventDate,
        publishedAt: normalizeTimestamp(row.published_at),
        headline,
        summary,
        source: safeString(row.source),
        url: safeString(row.url),
        tags,
        rowHash,
        rawPayload: row.raw_payload ? toJson(row.raw_payload) : toJson({ importedFrom: fullTable }),
      })
    }

    processed += rows.length
    if (data.length > 0) {
      inserted += await createManyBatched('policyNews1d', data, async (batch) =>
        (await prisma.policyNews1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
  }

  return { processed, inserted }
}

async function syncEconomicSeries(source: Client): Promise<number> {
  const tables: Array<{ full: string; category: EconCategory }> = [
    { full: 'econ.rates_1d', category: EconCategory.RATES },
    { full: 'econ.vol_indices_1d', category: EconCategory.VOLATILITY },
    { full: 'econ.inflation_1d', category: EconCategory.INFLATION },
    { full: 'econ.labor_1d', category: EconCategory.LABOR },
    { full: 'econ.activity_1d', category: EconCategory.ACTIVITY },
    { full: 'econ.money_1d', category: EconCategory.MONEY },
    { full: 'econ.commodities_1d', category: EconCategory.COMMODITIES },
  ]

  const rows: Prisma.EconomicSeriesCreateManyInput[] = []

  for (const table of tables) {
    const result = await withRetry(`${table.full} series sync`, () =>
      withTimeout(
        `${table.full} series sync`,
        source.query(`select distinct series_id from ${table.full} where series_id is not null order by series_id`)
      )
    )
    for (const item of result.rows) {
      const seriesId = String(item.series_id)
      rows.push({
        seriesId,
        displayName: seriesId,
        category: table.category,
        source: DataSource.FRED,
        sourceSymbol: seriesId,
        frequency: 'daily',
        units: null,
        isActive: true,
        metadata: toJson({ importedFrom: table.full }),
      })
    }
  }

  if (rows.length === 0) return 0
  const inserted = await createManyBatched(
    'economicSeries',
    rows,
    async (batch) => (await prisma.economicSeries.createMany({ data: batch, skipDuplicates: true })).count
  )
  return inserted
}

async function upsertRegistry(): Promise<void> {
  await withRetry('dataSourceRegistry.upsert', () => prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'fusion-econ-sync' },
    create: {
      sourceId: 'fusion-econ-sync',
      sourceName: 'Zinc Fusion V15 Econ Sync',
      description: 'Bulk import of Fusion FRED/econ/news/rates domains into Rabid Raccoon domain tables.',
      targetTable: 'econ_*,mkt_indexes_1d,econ_news_1d,policy_news_1d',
      apiProvider: 'fusion-postgres',
      updateFrequency: 'manual/bootstrap',
      authEnvVar: 'FUSION_DATABASE_URL',
      ingestionScript: 'scripts/import-fusion-econ.ts',
      isActive: true,
    },
    update: {
      sourceName: 'Zinc Fusion V15 Econ Sync',
      description: 'Bulk import of Fusion FRED/econ/news/rates domains into Rabid Raccoon domain tables.',
      targetTable: 'econ_*,mkt_indexes_1d,econ_news_1d,policy_news_1d',
      apiProvider: 'fusion-postgres',
      updateFrequency: 'manual/bootstrap',
      authEnvVar: 'FUSION_DATABASE_URL',
      ingestionScript: 'scripts/import-fusion-econ.ts',
      isActive: true,
    },
	}))
}

async function failStaleRuns(job: string): Promise<void> {
  const result = await prisma.ingestionRun.updateMany({
    where: {
      job,
      status: 'RUNNING',
    },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      rowsFailed: 1,
      details: toJson({
        reason: 'Marked stale before new run started',
        markedAt: new Date().toISOString(),
      }),
    },
  })

  if (result.count > 0) {
    console.warn(`[fusion-econ] marked ${result.count} stale RUNNING ingestion run(s) as FAILED`)
  }
}

export async function runImportFusionEcon(): Promise<void> {
  const jobName = 'fusion-econ-full-import'
  const source = new Client({
    connectionString: requireFusionUrl(),
    ssl: { rejectUnauthorized: false },
  })

  await source.connect()
  await upsertRegistry()
  await failStaleRuns(jobName)

  const run = await withRetry('ingestionRun.create', () => prisma.ingestionRun.create({
    data: {
      job: jobName,
      status: 'RUNNING',
      details: toJson({
        chunkSize: CHUNK_SIZE,
        writeBatchSize: WRITE_BATCH_SIZE,
        sections: Array.from(SECTION_FILTER),
      }),
    },
  }))

  let rowsProcessed = 0
  let rowsInserted = 0

  try {
    const stats: Record<string, { processed: number; inserted: number }> = {}

    const updateProgress = async (): Promise<void> => {
      await withRetry('ingestionRun.update.progress', () => prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          rowsProcessed,
          rowsInserted,
          details: toJson({
            chunkSize: CHUNK_SIZE,
            writeBatchSize: WRITE_BATCH_SIZE,
            sections: Array.from(SECTION_FILTER),
            stats,
          }),
        },
      }))
    }

    const runSection = async (
      section: ImportSection,
      label: string,
      fn: () => Promise<{ processed: number; inserted: number }>
    ): Promise<void> => {
      if (!shouldImport(section)) {
        console.log(`[fusion-econ] skip section=${section} (${label})`)
        return
      }

      console.log(`[fusion-econ] start section=${section} (${label})`)
      const result = await fn()
      stats[label] = result
      rowsProcessed += result.processed
      rowsInserted += result.inserted
      await updateProgress()
      console.log(
        `[fusion-econ] done section=${section} (${label}) processed=${result.processed} inserted=${result.inserted}`
      )
    }

    await runSection('rates', 'econ.rates_1d', () => importRatesDomain(source))
    await runSection('vol_indices', 'econ.vol_indices_1d', () =>
      importSimpleSeriesDomain(source, 'econ.vol_indices_1d', 'VOLATILITY')
    )
    await runSection('inflation', 'econ.inflation_1d', () =>
      importSimpleSeriesDomain(source, 'econ.inflation_1d', 'INFLATION')
    )
    await runSection('labor', 'econ.labor_1d', () => importSimpleSeriesDomain(source, 'econ.labor_1d', 'LABOR'))
    await runSection('activity', 'econ.activity_1d', () =>
      importSimpleSeriesDomain(source, 'econ.activity_1d', 'ACTIVITY')
    )
    await runSection('money', 'econ.money_1d', () => importSimpleSeriesDomain(source, 'econ.money_1d', 'MONEY'))
    await runSection('commodities', 'econ.commodities_1d', () =>
      importSimpleSeriesDomain(source, 'econ.commodities_1d', 'COMMODITIES')
    )
    await runSection('fx_spot', 'mkt.fx_1d', () => importFxSpot(source))
    await runSection('indexes', 'mkt.etf_1d', () => importEtfIndexes(source))

    await runSection('econ_news', 'econ.news_event', () => importEconNewsTable(source, 'econ.news_event'))
    await runSection('econ_news', 'alt.econ_news_event', () => importEconNewsTable(source, 'alt.econ_news_event'))
    await runSection('econ_news', 'alt.profarmer_news_event', () =>
      importEconNewsTable(source, 'alt.profarmer_news_event')
    )

    await runSection('policy_news', 'alt.policy_news_event', () =>
      importPolicyNewsTable(source, 'alt.policy_news_event')
    )
    await runSection('policy_news', 'alt.executive_actions_event', () =>
      importPolicyNewsTable(source, 'alt.executive_actions_event')
    )
    await runSection('policy_news', 'alt.ice_enforcement_event', () =>
      importPolicyNewsTable(source, 'alt.ice_enforcement_event')
    )
    await runSection('policy_news', 'alt.legislation_1d', () => importPolicyNewsTable(source, 'alt.legislation_1d'))

    let economicSeriesInserted = 0
    if (shouldImport('series')) {
      console.log('[fusion-econ] start section=series (economic_series)')
      economicSeriesInserted = await syncEconomicSeries(source)
      stats['economic_series'] = { processed: 0, inserted: economicSeriesInserted }
      rowsInserted += economicSeriesInserted
      await updateProgress()
      console.log(`[fusion-econ] done section=series (economic_series) inserted=${economicSeriesInserted}`)
    } else {
      console.log('[fusion-econ] skip section=series (economic_series)')
    }

    await withRetry('ingestionRun.update.success', () => prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        rowsProcessed,
        rowsInserted,
        rowsFailed: 0,
        details: toJson({
          chunkSize: CHUNK_SIZE,
          writeBatchSize: WRITE_BATCH_SIZE,
          sections: Array.from(SECTION_FILTER),
          stats,
          economicSeriesInserted,
        }),
      },
    }))

    console.log(JSON.stringify({ rowsProcessed, rowsInserted, economicSeriesInserted, stats }, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await withRetry('ingestionRun.update.failed', () => prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          rowsProcessed,
          rowsInserted,
          rowsFailed: 1,
          details: toJson({
            error: message,
            chunkSize: CHUNK_SIZE,
            writeBatchSize: WRITE_BATCH_SIZE,
            sections: Array.from(SECTION_FILTER),
          }),
        },
      }))
    } catch (updateError) {
      const updateMessage = updateError instanceof Error ? updateError.message : String(updateError)
      console.error(`[fusion-econ] failed to update ingestion run status: ${updateMessage}`)
    }
    throw error
  } finally {
    await source.end()
    await prisma.$disconnect()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runImportFusionEcon().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[fusion-econ] failed: ${message}`)
    process.exit(1)
  })
}
