/**
 * ingest-fred-complete.ts
 *
 * Comprehensive FRED ingestion — pulls ALL economic series from FRED API
 * for 2 years, truncates stale data, and inserts into domain-specific
 * Prisma tables (econ_rates_1d, econ_yields_1d, etc.).
 *
 * Mirrors zinc-fusion-v15 series catalog — 139 FRED series, zero Yahoo.
 *
 * Usage:
 *   npx tsx scripts/ingest-fred-complete.ts                # full fresh 2y pull
 *   npx tsx scripts/ingest-fred-complete.ts --days-back=90  # last 90 days only
 *   npx tsx scripts/ingest-fred-complete.ts --no-truncate   # append without wiping
 */

import { createHash } from 'node:crypto'
import { Prisma, DataSource } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
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

interface SeriesSpec {
  seriesId: string
  domain: EconDomain
  displayName: string
  units: string
  frequency: string
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function hashRow(seriesId: string, eventDate: Date, value: number, source: string): string {
  return createHash('sha256')
    .update(`${seriesId}|${eventDate.toISOString().slice(0, 10)}|${value}|${source}`)
    .digest('hex')
}

// ─── COMPLETE FRED SERIES CATALOG ──────────────────────────────────────────

// Data Dictionary v2.0 — 47 KEEP series only
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
]

// ─── DOMAIN INSERT FUNCTIONS ───────────────────────────────────────────────

interface ValueRow {
  seriesId: string
  eventDate: Date
  value: number
  source: DataSource
  rowHash: string
  metadata?: Prisma.InputJsonValue
}

export interface FredSeriesResult {
  seriesId: string
  domain: EconDomain
  fetched: number
  inserted: number
  error?: string
}

async function insertDomain(domain: EconDomain, rows: ValueRow[]): Promise<number> {
  if (rows.length === 0) return 0

  const splitData = rows.map((r) => ({
    seriesId: r.seriesId,
    eventDate: r.eventDate,
    value: r.value,
    source: r.source,
    rowHash: r.rowHash,
    metadata: r.metadata ?? toJson({ provider: r.source }),
  }))

  const splitInsertMap: Record<EconDomain, () => Promise<{ count: number }>> = {
    RATES: () => prisma.econRates1d.createMany({ data: splitData, skipDuplicates: true }),
    YIELDS: () => prisma.econYields1d.createMany({ data: splitData, skipDuplicates: true }),
    FX: () => prisma.econFx1d.createMany({ data: splitData, skipDuplicates: true }),
    VOL_INDICES: () => prisma.econVolIndices1d.createMany({ data: splitData, skipDuplicates: true }),
    INFLATION: () => prisma.econInflation1d.createMany({ data: splitData, skipDuplicates: true }),
    LABOR: () => prisma.econLabor1d.createMany({ data: splitData, skipDuplicates: true }),
    ACTIVITY: () => prisma.econActivity1d.createMany({ data: splitData, skipDuplicates: true }),
    MONEY: () => prisma.econMoney1d.createMany({ data: splitData, skipDuplicates: true }),
    COMMODITIES: () => prisma.econCommodities1d.createMany({ data: splitData, skipDuplicates: true }),
  }

  try {
    const inserted = await splitInsertMap[domain]()
    return inserted.count
  } catch (err) {
    console.warn(`[fred-complete] split table write failed for ${domain}: ${err instanceof Error ? err.message : err}`)
  }

  return 0
}

// ─── PER-SERIES EXPORT (used by Inngest per-step invocation) ───────────────

export async function runIngestOneFredSeries(
  spec: SeriesSpec,
  daysBack: number
): Promise<FredSeriesResult> {
  const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = new Date().toISOString().slice(0, 10)
  const fetchedAt = new Date().toISOString()

  try {
    const obs = await fetchFredSeries(spec.seriesId, startDate, endDate)
    const rows: ValueRow[] = obs
      .filter((o) => o.value !== '.' && Number.isFinite(Number(o.value)))
      .map((o) => {
        const value = Number(o.value)
        const eventDate = new Date(`${o.date}T00:00:00Z`)
        return {
          seriesId: spec.seriesId,
          eventDate,
          value,
          source: 'FRED' as DataSource,
          rowHash: hashRow(spec.seriesId, eventDate, value, 'FRED'),
          metadata: toJson({
            seriesId: spec.seriesId,
            domain: spec.domain,
            displayName: spec.displayName,
            frequency: spec.frequency,
            units: spec.units,
            daysBack,
            fetchedAt,
            observationCount: obs.length,
          }),
        }
      })

    await prisma.economicSeries.upsert({
      where: { seriesId: spec.seriesId },
      create: {
        seriesId: spec.seriesId,
        displayName: spec.displayName,
        category: domainToCategory(spec.domain),
        source: 'FRED',
        sourceSymbol: spec.seriesId,
        frequency: spec.frequency,
        units: spec.units,
        isActive: true,
      },
      update: {
        displayName: spec.displayName,
        category: domainToCategory(spec.domain),
        frequency: spec.frequency,
        units: spec.units,
        isActive: true,
      },
    })

    const inserted = await insertDomain(spec.domain, rows)
    return { seriesId: spec.seriesId, domain: spec.domain, fetched: rows.length, inserted }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { seriesId: spec.seriesId, domain: spec.domain, fetched: 0, inserted: 0, error: msg.slice(0, 300) }
  }
}

// ─── TRUNCATE ──────────────────────────────────────────────────────────────

async function truncateEconTables(): Promise<void> {
  console.log('[fred-complete] deleting all econ rows...')
  // Delete split observations first (FK child), then series (FK parent)
  const splitResults = await Promise.all([
    prisma.econRates1d.deleteMany(),
    prisma.econYields1d.deleteMany(),
    prisma.econFx1d.deleteMany(),
    prisma.econVolIndices1d.deleteMany(),
    prisma.econInflation1d.deleteMany(),
    prisma.econLabor1d.deleteMany(),
    prisma.econActivity1d.deleteMany(),
    prisma.econMoney1d.deleteMany(),
    prisma.econCommodities1d.deleteMany(),
  ])
  const seriesResult = await prisma.economicSeries.deleteMany()
  const total = splitResults.reduce((sum, r) => sum + r.count, 0) + seriesResult.count
  console.log(`[fred-complete] deleted ${total.toLocaleString()} rows.`)
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function run() {
  loadDotEnvFiles()
  if (!process.env.FRED_API_KEY) throw new Error('FRED_API_KEY is required')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

  const args = process.argv.slice(2)
  const daysBack = Number(args.find((a) => a.startsWith('--days-back='))?.split('=')[1] ?? '730')
  const noTruncate = args.includes('--no-truncate')

  const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endDate = new Date().toISOString().slice(0, 10)

  console.log(`[fred-complete] ${FRED_SERIES.length} FRED series (zero Yahoo)`)
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
      const obs = await fetchFredSeries(spec.seriesId, startDate, endDate)
      const rows: ValueRow[] = obs
        .filter((o) => o.value !== '.' && Number.isFinite(Number(o.value)))
        .map((o) => {
          const value = Number(o.value)
          const eventDate = new Date(`${o.date}T00:00:00Z`)
          return {
            seriesId: spec.seriesId,
            eventDate,
            value,
            source: 'FRED',
            rowHash: hashRow(spec.seriesId, eventDate, value, 'FRED'),
          }
        })

      // Upsert economic_series FIRST (FK parent for domain econ tables)
      await prisma.economicSeries.upsert({
        where: { seriesId: spec.seriesId },
        create: {
          seriesId: spec.seriesId,
          displayName: spec.displayName,
          category: domainToCategory(spec.domain),
          source: 'FRED',
          sourceSymbol: spec.seriesId,
          frequency: spec.frequency,
          units: spec.units,
          isActive: true,
        },
        update: {
          displayName: spec.displayName,
          category: domainToCategory(spec.domain),
          frequency: spec.frequency,
          units: spec.units,
          isActive: true,
        },
      })

      const inserted = await insertDomain(spec.domain, rows)

      totalFetched += rows.length
      totalInserted += inserted
      if (!domainCounts[spec.domain]) domainCounts[spec.domain] = { fetched: 0, inserted: 0 }
      domainCounts[spec.domain].fetched += rows.length
      domainCounts[spec.domain].inserted += inserted

      console.log(`${label} → ${rows.length} obs, ${inserted} new (${spec.domain})`)

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
  await prisma.ingestionRun.create({
    data: {
      job: 'fred-complete',
      status: Object.keys(failed).length === 0 ? 'COMPLETED' : 'FAILED',
      finishedAt: new Date(),
      rowsProcessed: totalFetched,
      rowsInserted: totalInserted,
      rowsFailed: Object.keys(failed).length,
      details: toJson({ daysBack, domainCounts, failed }),
    },
  })

  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'fred-complete' },
    create: {
      sourceId: 'fred-complete',
      sourceName: 'FRED Complete Economic Dataset',
      description: `${FRED_SERIES.length} FRED series across 9 econ domains (mirrors zinc-fusion-v15).`,
      targetTable: 'econ_*_1d',
      apiProvider: 'fred',
      updateFrequency: 'daily',
      authEnvVar: 'FRED_API_KEY',
      ingestionScript: 'scripts/ingest-fred-complete.ts',
      isActive: true,
    },
    update: {
      description: `${FRED_SERIES.length} FRED series across 9 econ domains (mirrors zinc-fusion-v15).`,
      isActive: true,
    },
  })
}

function domainToCategory(domain: EconDomain) {
  const map: Record<EconDomain, string> = {
    RATES: 'RATES',
    YIELDS: 'YIELDS',
    FX: 'FX',
    VOL_INDICES: 'VOLATILITY',
    INFLATION: 'INFLATION',
    LABOR: 'LABOR',
    ACTIVITY: 'ACTIVITY',
    MONEY: 'MONEY',
    COMMODITIES: 'COMMODITIES',
  }
  return map[domain] as Parameters<typeof prisma.economicSeries.create>[0]['data']['category']
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

run()
  .then(() => {
    console.log('\n[fred-complete] done.')
    process.exit(0)
  })
  .catch((err) => {
    console.error(`[fred-complete] fatal: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
