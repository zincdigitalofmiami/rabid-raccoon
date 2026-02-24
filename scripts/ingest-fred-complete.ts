/**
 * ingest-fred-complete.ts
 *
 * Comprehensive FRED ingestion — pulls ALL economic series from FRED API,
 * upserts into domain-specific tables via direct pg (bypasses Accelerate).
 *
 * Uses DIRECT_URL for writes (same pattern as trade-recorder.ts).
 * Prisma Accelerate times out on batch createMany — direct pg does not.
 *
 * Usage:
 *   npx tsx scripts/ingest-fred-complete.ts                # full fresh 2y pull
 *   npx tsx scripts/ingest-fred-complete.ts --days-back=90  # last 90 days only
 *   npx tsx scripts/ingest-fred-complete.ts --no-truncate   # append without wiping
 */

import { createHash } from 'node:crypto'
import pg from 'pg'
import { fetchFredSeries } from '../src/lib/fred'
import { loadDotEnvFiles } from './ingest-utils'

type EconDomain =
  | 'RATES'
  | 'YIELDS'
  | 'FX'
  | 'VOL_INDICES'
  | 'INFLATION'
  | 'LABOR'
  | 'ACTIVITY'
  | 'MONEY'
  | 'COMMODITIES'
  | 'INDEXES'

interface SeriesSpec {
  seriesId: string
  domain: EconDomain
  displayName: string
  units: string
  frequency: string
}

function hashRow(seriesId: string, eventDate: string, value: number, source: string): string {
  return createHash('sha256')
    .update(`${seriesId}|${eventDate}|${value}|${source}`)
    .digest('hex')
}

// ─── DIRECT PG POOL (bypasses Prisma Accelerate) ─────────────────────────

let pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DIRECT_URL || process.env.DATABASE_URL
    if (!url) throw new Error('Neither DIRECT_URL nor DATABASE_URL is set')
    pool = new pg.Pool({ connectionString: url, max: 3 })
  }
  return pool
}

// ─── COMPLETE FRED SERIES CATALOG ──────────────────────────────────────────

// Data Dictionary v2.1 — 50 series (47 original + 3 equity indexes)
export const FRED_SERIES: SeriesSpec[] = [
  // ── RATES (5) ──
  { seriesId: 'DFF', domain: 'RATES', displayName: 'Federal Funds Effective Rate', units: 'percent', frequency: 'daily' },
  { seriesId: 'DFEDTARL', domain: 'RATES', displayName: 'Fed Funds Target Range Lower', units: 'percent', frequency: 'daily' },
  { seriesId: 'DFEDTARU', domain: 'RATES', displayName: 'Fed Funds Target Range Upper', units: 'percent', frequency: 'daily' },
  { seriesId: 'T10Y2Y', domain: 'RATES', displayName: '10Y-2Y Treasury Spread', units: 'percent', frequency: 'daily' },
  { seriesId: 'SOFR', domain: 'RATES', displayName: 'Secured Overnight Financing Rate', units: 'percent', frequency: 'daily' },

  // ── YIELDS (5) ──
  { seriesId: 'DGS2', domain: 'YIELDS', displayName: '2-Year Treasury', units: 'percent', frequency: 'daily' },
  { seriesId: 'DGS5', domain: 'YIELDS', displayName: '5-Year Treasury', units: 'percent', frequency: 'daily' },
  { seriesId: 'DGS10', domain: 'YIELDS', displayName: '10-Year Treasury', units: 'percent', frequency: 'daily' },
  { seriesId: 'DGS30', domain: 'YIELDS', displayName: '30-Year Treasury', units: 'percent', frequency: 'daily' },
  { seriesId: 'DGS3MO', domain: 'YIELDS', displayName: '3-Month Treasury', units: 'percent', frequency: 'daily' },

  // ── VOL & CREDIT (7) ──
  { seriesId: 'VIXCLS', domain: 'VOL_INDICES', displayName: 'CBOE VIX', units: 'index', frequency: 'daily' },
  { seriesId: 'VXVCLS', domain: 'VOL_INDICES', displayName: 'CBOE VVIX', units: 'index', frequency: 'daily' },
  { seriesId: 'BAMLH0A0HYM2', domain: 'VOL_INDICES', displayName: 'US High Yield OAS', units: 'percent', frequency: 'daily' },
  { seriesId: 'BAMLC0A0CM', domain: 'VOL_INDICES', displayName: 'US Corp Bond OAS', units: 'percent', frequency: 'daily' },
  { seriesId: 'OVXCLS', domain: 'VOL_INDICES', displayName: 'CBOE Crude Oil Volatility', units: 'index', frequency: 'daily' },
  { seriesId: 'NFCI', domain: 'VOL_INDICES', displayName: 'Chicago Fed Financial Conditions', units: 'index', frequency: 'weekly' },
  { seriesId: 'USEPUINDXD', domain: 'VOL_INDICES', displayName: 'Economic Policy Uncertainty (daily)', units: 'index', frequency: 'daily' },

  // ── INFLATION (9) — 5 daily + 4 monthly event flags ──
  { seriesId: 'T10YIE', domain: 'INFLATION', displayName: '10Y Inflation Expectations', units: 'percent', frequency: 'daily' },
  { seriesId: 'T5YIFR', domain: 'INFLATION', displayName: '5Y5Y Forward Inflation', units: 'percent', frequency: 'daily' },
  { seriesId: 'DFII10', domain: 'INFLATION', displayName: '10Y TIPS Real Yield', units: 'percent', frequency: 'daily' },
  { seriesId: 'DFII5', domain: 'INFLATION', displayName: '5Y TIPS Real Yield', units: 'percent', frequency: 'daily' },
  { seriesId: 'T5YIE', domain: 'INFLATION', displayName: '5Y Inflation Expectations', units: 'percent', frequency: 'daily' },
  { seriesId: 'CPIAUCSL', domain: 'INFLATION', displayName: 'CPI All Urban Consumers', units: 'index', frequency: 'monthly' },
  { seriesId: 'CPILFESL', domain: 'INFLATION', displayName: 'Core CPI (ex food/energy)', units: 'index', frequency: 'monthly' },
  { seriesId: 'PCEPILFE', domain: 'INFLATION', displayName: 'Core PCE (ex food/energy)', units: 'index', frequency: 'monthly' },
  { seriesId: 'PPIACO', domain: 'INFLATION', displayName: 'PPI All Commodities', units: 'index', frequency: 'monthly' },

  // ── FX (5) ──
  { seriesId: 'DTWEXBGS', domain: 'FX', displayName: 'Trade Weighted Dollar Index (Broad)', units: 'index', frequency: 'daily' },
  { seriesId: 'DEXUSEU', domain: 'FX', displayName: 'USD/EUR', units: 'currency', frequency: 'daily' },
  { seriesId: 'DEXJPUS', domain: 'FX', displayName: 'JPY/USD', units: 'currency', frequency: 'daily' },
  { seriesId: 'DEXCHUS', domain: 'FX', displayName: 'CNY/USD', units: 'currency', frequency: 'daily' },
  { seriesId: 'DEXMXUS', domain: 'FX', displayName: 'MXN/USD', units: 'currency', frequency: 'daily' },

  // ── LABOR (4) ──
  { seriesId: 'ICSA', domain: 'LABOR', displayName: 'Initial Jobless Claims', units: 'number', frequency: 'weekly' },
  { seriesId: 'CCSA', domain: 'LABOR', displayName: 'Continuing Jobless Claims', units: 'number', frequency: 'weekly' },
  { seriesId: 'PAYEMS', domain: 'LABOR', displayName: 'Total Nonfarm Payrolls', units: 'thousands', frequency: 'monthly' },
  { seriesId: 'UNRATE', domain: 'LABOR', displayName: 'Unemployment Rate', units: 'percent', frequency: 'monthly' },

  // ── ACTIVITY (6) ──
  { seriesId: 'GDPC1', domain: 'ACTIVITY', displayName: 'Real GDP', units: 'billions', frequency: 'quarterly' },
  { seriesId: 'RSXFS', domain: 'ACTIVITY', displayName: 'Retail Sales (ex food svc)', units: 'millions', frequency: 'monthly' },
  { seriesId: 'UMCSENT', domain: 'ACTIVITY', displayName: 'U of Michigan Consumer Sentiment', units: 'index', frequency: 'monthly' },
  { seriesId: 'INDPRO', domain: 'ACTIVITY', displayName: 'Industrial Production Index', units: 'index', frequency: 'monthly' },
  { seriesId: 'BOPGSTB', domain: 'ACTIVITY', displayName: 'Trade Balance', units: 'millions', frequency: 'monthly' },
  { seriesId: 'IMPCH', domain: 'ACTIVITY', displayName: 'US Imports from China', units: 'millions', frequency: 'monthly' },

  // ── COMMODITIES (3) ──
  { seriesId: 'DCOILWTICO', domain: 'COMMODITIES', displayName: 'WTI Crude Oil', units: 'usd/barrel', frequency: 'daily' },
  { seriesId: 'DCOILBRENTEU', domain: 'COMMODITIES', displayName: 'Brent Crude Oil', units: 'usd/barrel', frequency: 'daily' },
  { seriesId: 'PCOPPUSDM', domain: 'COMMODITIES', displayName: 'Copper Price', units: 'usd/mt', frequency: 'monthly' },

  // ── MONEY (3) ──
  { seriesId: 'WALCL', domain: 'MONEY', displayName: 'Fed Total Assets', units: 'millions', frequency: 'weekly' },
  { seriesId: 'RRPONTSYD', domain: 'MONEY', displayName: 'Overnight Reverse Repo', units: 'billions', frequency: 'daily' },
  { seriesId: 'M2SL', domain: 'MONEY', displayName: 'M2 Money Supply', units: 'billions', frequency: 'monthly' },

  // ── INDEXES (3) — FRED equity indices ──
  { seriesId: 'SP500', domain: 'INDEXES', displayName: 'S&P 500', units: 'index', frequency: 'daily' },
  { seriesId: 'NASDAQCOM', domain: 'INDEXES', displayName: 'NASDAQ Composite', units: 'index', frequency: 'daily' },
  { seriesId: 'DJIA', domain: 'INDEXES', displayName: 'Dow Jones Industrial Average', units: 'index', frequency: 'daily' },
]

// ─── DOMAIN → TABLE MAPPING ──────────────────────────────────────────────

const DOMAIN_TABLE: Record<EconDomain, string> = {
  RATES: 'econ_rates_1d',
  YIELDS: 'econ_yields_1d',
  FX: 'econ_fx_1d',
  VOL_INDICES: 'econ_vol_indices_1d',
  INFLATION: 'econ_inflation_1d',
  LABOR: 'econ_labor_1d',
  ACTIVITY: 'econ_activity_1d',
  MONEY: 'econ_money_1d',
  COMMODITIES: 'econ_commodities_1d',
  INDEXES: 'econ_indexes_1d',
}

const DOMAIN_CATEGORY: Record<EconDomain, string> = {
  RATES: 'RATES',
  YIELDS: 'YIELDS',
  FX: 'FX',
  VOL_INDICES: 'VOLATILITY',
  INFLATION: 'INFLATION',
  LABOR: 'LABOR',
  ACTIVITY: 'ACTIVITY',
  MONEY: 'MONEY',
  COMMODITIES: 'COMMODITIES',
  INDEXES: 'EQUITY',
}

// ─── DIRECT PG INSERT (bypasses Prisma Accelerate) ───────────────────────

export interface FredSeriesResult {
  seriesId: string
  domain: EconDomain
  fetched: number
  inserted: number
  error?: string
}

async function upsertEconomicSeries(spec: SeriesSpec): Promise<void> {
  const db = getPool()
  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO economic_series ("seriesId", "displayName", category, source, "sourceSymbol", frequency, units, "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'FRED', $4, $5, $6, true, $7, $7)
     ON CONFLICT ("seriesId") DO UPDATE SET
       "displayName" = EXCLUDED."displayName",
       category = EXCLUDED.category,
       frequency = EXCLUDED.frequency,
       units = EXCLUDED.units,
       "isActive" = true,
       "updatedAt" = EXCLUDED."updatedAt"`,
    [spec.seriesId, spec.displayName, DOMAIN_CATEGORY[spec.domain], spec.seriesId, spec.frequency, spec.units, now]
  )
}

interface ValueRow {
  seriesId: string
  eventDate: string  // YYYY-MM-DD
  value: number
  rowHash: string
  metadata: string   // JSON string
}

async function insertDomain(domain: EconDomain, rows: ValueRow[]): Promise<number> {
  if (rows.length === 0) return 0

  const table = DOMAIN_TABLE[domain]
  const db = getPool()
  let inserted = 0

  // Batch insert — 50 rows per statement to stay well under param limits
  const BATCH = 50
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const values: unknown[] = []
    const placeholders: string[] = []

    const ingestedAt = new Date().toISOString()
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j]
      const offset = j * 6
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, 'FRED', $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb)`)
      values.push(r.seriesId, r.eventDate, r.value, r.rowHash, ingestedAt, r.metadata)
    }

    const result = await db.query(
      `INSERT INTO "${table}" ("seriesId", "eventDate", value, source, "rowHash", "ingestedAt", metadata)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT ("seriesId", "eventDate") DO UPDATE SET
         value = EXCLUDED.value,
         "rowHash" = EXCLUDED."rowHash",
         "ingestedAt" = EXCLUDED."ingestedAt",
         metadata = EXCLUDED.metadata`,
      values
    )
    inserted += result.rowCount ?? 0
  }

  return inserted
}

// ─── PER-SERIES EXPORT (used by Inngest per-step invocation) ───────────────

export async function runIngestOneFredSeries(
  spec: SeriesSpec,
  daysBack: number
): Promise<FredSeriesResult> {
  const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = new Date().toISOString().slice(0, 10)
  const fetchedAt = new Date().toISOString()

  console.log(`[fred] ${spec.seriesId} (${spec.domain}) start — range ${startDate}→${endDate}, daysBack=${daysBack}`)

  try {
    const obs = await fetchFredSeries(spec.seriesId, startDate, endDate)
    console.log(`[fred] ${spec.seriesId} fetched ${obs.length} observations from FRED API`)

    const rows: ValueRow[] = obs
      .filter((o) => o.value !== '.' && Number.isFinite(Number(o.value)))
      .map((o) => ({
        seriesId: spec.seriesId,
        eventDate: o.date,
        value: Number(o.value),
        rowHash: hashRow(spec.seriesId, o.date, Number(o.value), 'FRED'),
        metadata: JSON.stringify({
          seriesId: spec.seriesId,
          domain: spec.domain,
          displayName: spec.displayName,
          frequency: spec.frequency,
          units: spec.units,
          daysBack,
          fetchedAt,
          observationCount: obs.length,
        }),
      }))

    await upsertEconomicSeries(spec)
    console.log(`[fred] ${spec.seriesId} economic_series upsert OK`)

    const inserted = await insertDomain(spec.domain, rows)
    console.log(`[fred] ${spec.seriesId} → ${rows.length} fetched, ${inserted} inserted into ${spec.domain}`)
    return { seriesId: spec.seriesId, domain: spec.domain, fetched: rows.length, inserted }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[fred] ${spec.seriesId} FAILED: ${msg.slice(0, 500)}`)
    return { seriesId: spec.seriesId, domain: spec.domain, fetched: 0, inserted: 0, error: msg.slice(0, 300) }
  }
}

// ─── TRUNCATE ──────────────────────────────────────────────────────────────

async function truncateEconTables(): Promise<void> {
  console.log('[fred-complete] deleting all econ rows...')
  const db = getPool()
  let total = 0
  for (const table of Object.values(DOMAIN_TABLE)) {
    const result = await db.query(`DELETE FROM "${table}"`)
    total += result.rowCount ?? 0
  }
  const seriesResult = await db.query('DELETE FROM economic_series')
  total += seriesResult.rowCount ?? 0
  console.log(`[fred-complete] deleted ${total.toLocaleString()} rows.`)
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function run() {
  loadDotEnvFiles()
  if (!process.env.FRED_API_KEY) throw new Error('FRED_API_KEY is required')
  if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) throw new Error('DIRECT_URL or DATABASE_URL is required')

  const args = process.argv.slice(2)
  const daysBack = Number(args.find((a) => a.startsWith('--days-back='))?.split('=')[1] ?? '730')
  const noTruncate = args.includes('--no-truncate')

  const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = new Date().toISOString().slice(0, 10)

  console.log(`[fred-complete] ${FRED_SERIES.length} FRED series, direct pg (no Accelerate)`)
  console.log(`[fred-complete] range: ${startDate} → ${endDate} (${daysBack} days)`)
  console.log(`[fred-complete] truncate: ${!noTruncate}`)

  if (!noTruncate) {
    await truncateEconTables()
  }

  // ── Fetch all FRED series ──
  const domainCounts: Record<string, { fetched: number; inserted: number }> = {}
  const failed: Record<string, string> = {}
  let totalFetched = 0
  let totalInserted = 0

  for (let i = 0; i < FRED_SERIES.length; i++) {
    const spec = FRED_SERIES[i]
    const label = `[${i + 1}/${FRED_SERIES.length}] ${spec.seriesId}`
    try {
      const result = await runIngestOneFredSeries(spec, daysBack)

      if (result.error) {
        failed[spec.seriesId] = result.error
        console.error(`${label} FAILED: ${result.error}`)
      } else {
        totalFetched += result.fetched
        totalInserted += result.inserted
        if (!domainCounts[spec.domain]) domainCounts[spec.domain] = { fetched: 0, inserted: 0 }
        domainCounts[spec.domain].fetched += result.fetched
        domainCounts[spec.domain].inserted += result.inserted
        console.log(`${label} → ${result.fetched} obs, ${result.inserted} new (${spec.domain})`)
      }

      // FRED rate limit: 120 req/min → ~500ms between requests
      if (i < FRED_SERIES.length - 1) await sleep(500)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      failed[spec.seriesId] = msg.slice(0, 200)
      console.error(`${label} FAILED: ${failed[spec.seriesId]}`)
      await sleep(1000)
    }
  }

  // ── Summary ──
  console.log('\n═══ FRED COMPLETE INGESTION SUMMARY ═══')
  console.log(`FRED series: ${FRED_SERIES.length} attempted, ${FRED_SERIES.length - Object.keys(failed).length} succeeded`)
  console.log(`Total rows: ${totalFetched} fetched, ${totalInserted} inserted`)
  console.log('\nDomain breakdown:')
  for (const [domain, counts] of Object.entries(domainCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${domain.padEnd(15)} ${String(counts.inserted).padStart(7)} rows`)
  }
  if (Object.keys(failed).length > 0) {
    console.log(`\nFailed (${Object.keys(failed).length}):`)
    for (const [id, msg] of Object.entries(failed)) {
      console.log(`  ${id}: ${msg}`)
    }
  }

  // Record ingestion run
  const db = getPool()
  await db.query(
    `INSERT INTO ingestion_runs (job, status, "finishedAt", "rowsProcessed", "rowsInserted", "rowsFailed", details)
     VALUES ($1, $2, NOW(), $3, $4, $5, $6::jsonb)`,
    [
      'fred-complete',
      Object.keys(failed).length === 0 ? 'COMPLETED' : 'FAILED',
      totalFetched,
      totalInserted,
      Object.keys(failed).length,
      JSON.stringify({ daysBack, domainCounts, failed }),
    ]
  )

  const now = new Date().toISOString()
  await db.query(
    `INSERT INTO data_source_registry ("sourceId", "sourceName", description, "targetTable", "apiProvider", "updateFrequency", "authEnvVar", "ingestionScript", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)
     ON CONFLICT ("sourceId") DO UPDATE SET description = EXCLUDED.description, "isActive" = true, "updatedAt" = EXCLUDED."updatedAt"`,
    [
      'fred-complete',
      'FRED Complete Economic Dataset',
      `${FRED_SERIES.length} FRED series across 10 econ domains (direct pg, no Accelerate).`,
      'econ_*_1d',
      'fred',
      'daily',
      'FRED_API_KEY',
      'scripts/ingest-fred-complete.ts',
      now,
    ]
  )

  await db.end()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url?.endsWith('/scripts/ingest-fred-complete.ts')

if (isMain) {
  run()
    .then(() => {
      console.log('\n[fred-complete] done.')
      process.exit(0)
    })
    .catch((err) => {
      console.error(`[fred-complete] fatal: ${err instanceof Error ? err.message : err}`)
      process.exit(1)
    })
}
