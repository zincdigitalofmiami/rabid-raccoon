import { createHash } from 'node:crypto'
import { Prisma, ReportCategory } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

type FeedKind = 'econ' | 'policy'

interface FeedConfig {
  id: string
  url: string
  kind: FeedKind
  source: string
  tags: string[]
  country?: string
  writeMacroReport?: boolean
}

interface ParsedItem {
  title: string
  link: string | null
  summary: string | null
  content: string | null
  publishedAt: Date | null
  articleId: string | null
  author: string | null
  categories: string[]
}

interface FeedStats {
  fetchedItems: number
  parsedItems: number
  econInserted: number
  policyInserted: number
  reportInserted: number
  errors: string[]
}

interface RunStats {
  feeds: Record<string, FeedStats>
  totals: {
    fetchedItems: number
    parsedItems: number
    econInserted: number
    policyInserted: number
    reportInserted: number
  }
}

const FEEDS: FeedConfig[] = [
  {
    id: 'fed_press_all',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    kind: 'policy',
    source: 'federalreserve_press',
    tags: ['fed', 'monetary-policy', 'central-bank'],
    country: 'US',
    writeMacroReport: true,
  },
  {
    id: 'sec_press',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    kind: 'policy',
    source: 'sec_press',
    tags: ['sec', 'regulation', 'markets'],
    country: 'US',
    writeMacroReport: false,
  },
  {
    id: 'ecb_press',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    kind: 'policy',
    source: 'ecb_press',
    tags: ['ecb', 'central-bank', 'europe'],
    country: 'EU',
    writeMacroReport: true,
  },
  {
    id: 'bea_news',
    url: 'https://apps.bea.gov/rss/rss.xml',
    kind: 'econ',
    source: 'bea_news',
    tags: ['bea', 'gdp', 'national-accounts'],
    country: 'US',
    writeMacroReport: true,
  },
  {
    id: 'eia_today',
    url: 'https://www.eia.gov/rss/todayinenergy.xml',
    kind: 'econ',
    source: 'eia_today',
    tags: ['eia', 'energy', 'commodities'],
    country: 'US',
    writeMacroReport: true,
  },
  {
    id: 'eia_press',
    url: 'https://www.eia.gov/rss/press_rss.xml',
    kind: 'econ',
    source: 'eia_press',
    tags: ['eia', 'energy', 'commodities', 'press-release'],
    country: 'US',
    writeMacroReport: true,
  },
  {
    id: 'cftc_rule_proposed',
    url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',
    kind: 'policy',
    source: 'cftc_rule_proposed',
    tags: ['cftc', 'regulation', 'derivatives'],
    country: 'US',
    writeMacroReport: false,
  },
  {
    id: 'cftc_enforcement',
    url: 'https://www.cftc.gov/RSS/RSSENF/rssenf.xml',
    kind: 'policy',
    source: 'cftc_enforcement',
    tags: ['cftc', 'enforcement', 'derivatives'],
    country: 'US',
    writeMacroReport: false,
  },
  {
    id: 'cftc_speeches',
    url: 'https://www.cftc.gov/RSS/RSSST/rssst.xml',
    kind: 'policy',
    source: 'cftc_speeches',
    tags: ['cftc', 'policy', 'speeches'],
    country: 'US',
    writeMacroReport: false,
  },
]

const FETCH_TIMEOUT_MS = 20_000
const INSERT_BATCH_SIZE = 300

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function cleanText(value: string | null): string | null {
  if (!value) return null
  const text = stripHtml(decodeEntities(stripCdata(value))).trim()
  return text.length ? text : null
}

function normalizeDateOnly(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()))
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function shortHash(value: string): string {
  return hashKey(value).slice(0, 12)
}

function extractFirstTag(xml: string, tagNames: string[]): string | null {
  for (const name of tagNames) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')
    const match = xml.match(re)
    if (match && match[1]) return match[1]
  }
  return null
}

function extractCategories(xml: string): string[] {
  const tags = ['category', 'dc:subject']
  const out: string[] = []
  for (const tag of tags) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
    let match: RegExpExecArray | null
    while ((match = re.exec(xml)) !== null) {
      const value = cleanText(match[1])
      if (value) out.push(value)
    }
  }
  return [...new Set(out)]
}

function extractAtomLink(xml: string): string | null {
  const match = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)
  return match?.[1] || null
}

function parseDate(value: string | null): Date | null {
  if (!value) return null
  const dt = new Date(value)
  return Number.isFinite(dt.getTime()) ? dt : null
}

function parseRssLikeItems(xml: string): ParsedItem[] {
  const items: ParsedItem[] = []

  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || []
  for (const rawItem of rssItems) {
    const title = cleanText(extractFirstTag(rawItem, ['title']))
    if (!title) continue

    const summary = cleanText(extractFirstTag(rawItem, ['description', 'summary']))
    const content = cleanText(extractFirstTag(rawItem, ['content:encoded']))
    const link = cleanText(extractFirstTag(rawItem, ['link']))
    const articleId = cleanText(extractFirstTag(rawItem, ['guid']))
    const author = cleanText(extractFirstTag(rawItem, ['dc:creator', 'author']))
    const publishedAt = parseDate(
      cleanText(extractFirstTag(rawItem, ['pubDate', 'dc:date', 'published', 'updated']))
    )

    items.push({
      title,
      link,
      summary: summary || content,
      content: content || summary,
      publishedAt,
      articleId,
      author,
      categories: extractCategories(rawItem),
    })
  }

  if (items.length > 0) return items

  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || []
  for (const rawEntry of atomEntries) {
    const title = cleanText(extractFirstTag(rawEntry, ['title']))
    if (!title) continue

    const summary = cleanText(extractFirstTag(rawEntry, ['summary', 'content']))
    const link = extractAtomLink(rawEntry)
    const articleId = cleanText(extractFirstTag(rawEntry, ['id']))
    const author = cleanText(extractFirstTag(rawEntry, ['name', 'author']))
    const publishedAt = parseDate(cleanText(extractFirstTag(rawEntry, ['published', 'updated'])))

    items.push({
      title,
      link,
      summary,
      content: summary,
      publishedAt,
      articleId,
      author,
      categories: extractCategories(rawEntry),
    })
  }

  return items
}

async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RabidRaccoonBot/1.0; +https://rabid-raccoon.vercel.app)',
        Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml;q=0.9, */*;q=0.1',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 220)}`)
    }
    return response.text()
  } finally {
    clearTimeout(timeout)
  }
}

function inferReportCategory(title: string): ReportCategory {
  const t = title.toLowerCase()
  if (/\bcpi\b|consumer price/.test(t)) return ReportCategory.CPI
  if (/\bppi\b|producer price/.test(t)) return ReportCategory.PPI
  if (/\bpce\b|personal consumption expenditures/.test(t)) return ReportCategory.PCE
  if (/\bemployment\b|\bpayroll\b|\bunemployment\b|\bjob(s)?\b/.test(t)) return ReportCategory.EMPLOYMENT
  if (/\bgdp\b|gross domestic product/.test(t)) return ReportCategory.GDP
  if (/\bpmi\b|\bism\b|purchasing managers/.test(t)) return ReportCategory.PMI
  if (/\bretail\b/.test(t)) return ReportCategory.RETAIL
  if (/\bhousing\b|\bhome\b/.test(t)) return ReportCategory.HOUSING
  if (/\bpolicy\b|\brate(s)?\b|\bfomc\b|\bcentral bank\b|\bregulation\b/.test(t)) return ReportCategory.POLICY
  return ReportCategory.OTHER
}

function buildRowHash(feedId: string, item: ParsedItem, eventDate: Date): string {
  return hashKey(`${feedId}|${item.articleId || ''}|${item.link || ''}|${eventDate.toISOString().slice(0, 10)}|${item.title}`)
}

async function createManyBatched<T>(
  rows: T[],
  writer: (batch: T[]) => Promise<number>
): Promise<number> {
  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE)
    inserted += await writer(batch)
  }
  return inserted
}

async function upsertRegistry(): Promise<void> {
  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'alt-news-rss-sync' },
    create: {
      sourceId: 'alt-news-rss-sync',
      sourceName: 'Institutional RSS Alt News',
      description: 'Alt-news sync from institutional RSS feeds (Fed/SEC/ECB/BEA/EIA/CFTC).',
      targetTable: 'econ_news_1d,policy_news_1d,macro_reports_1d',
      apiProvider: 'public-rss',
      updateFrequency: 'daily',
      ingestionScript: 'scripts/ingest-alt-news-feeds.ts',
      isActive: true,
    },
    update: {
      sourceName: 'Institutional RSS Alt News',
      description: 'Alt-news sync from institutional RSS feeds (Fed/SEC/ECB/BEA/EIA/CFTC).',
      targetTable: 'econ_news_1d,policy_news_1d,macro_reports_1d',
      apiProvider: 'public-rss',
      updateFrequency: 'daily',
      ingestionScript: 'scripts/ingest-alt-news-feeds.ts',
      isActive: true,
    },
  })
}

function buildEconRow(feed: FeedConfig, item: ParsedItem, eventDate: Date, rowHash: string, tags: string[]): Prisma.EconNews1dCreateManyInput {
  return {
    articleId: item.articleId, eventDate, publishedAt: item.publishedAt,
    headline: item.title, summary: item.summary || item.content, content: item.content || item.summary,
    source: feed.source, author: item.author, url: item.link,
    topics: item.categories, subjects: [], tags, rowHash,
    rawPayload: toJson({ importedFrom: feed.url, feedId: feed.id }),
  }
}

function buildPolicyRow(feed: FeedConfig, item: ParsedItem, eventDate: Date, rowHash: string, tags: string[]): Prisma.PolicyNews1dCreateManyInput {
  return {
    eventDate, publishedAt: item.publishedAt, headline: item.title,
    summary: item.summary || item.content, source: feed.source,
    region: feed.country === 'EU' ? 'Europe' : 'United States',
    country: feed.country || null, url: item.link, tags, rowHash,
    rawPayload: toJson({ importedFrom: feed.url, feedId: feed.id }),
  }
}

function buildReportRow(feed: FeedConfig, item: ParsedItem, eventDate: Date): Prisma.MacroReport1dCreateManyInput {
  return {
    reportCode: `${feed.id}-${shortHash(item.title)}`.slice(0, 50),
    reportName: item.title.slice(0, 200),
    category: inferReportCategory(item.title),
    eventDate, releaseTime: item.publishedAt,
    periodLabel: null, actual: null, forecast: null, previous: null,
    revised: null, surprise: null, surprisePct: null, unit: null,
    source: feed.source, country: feed.country || null,
    rowHash: hashKey(`report|${feed.id}|${item.title}|${eventDate.toISOString().slice(0, 10)}`),
    rawPayload: toJson({ importedFrom: feed.url, feedId: feed.id, articleId: item.articleId, url: item.link }),
  }
}

async function processAltNewsFeed(feed: FeedConfig): Promise<FeedStats> {
  const feedStats: FeedStats = { fetchedItems: 0, parsedItems: 0, econInserted: 0, policyInserted: 0, reportInserted: 0, errors: [] }

  try {
    const xml = await fetchFeedXml(feed.url)
    const parsedItems = parseRssLikeItems(xml)
    feedStats.fetchedItems = parsedItems.length
    feedStats.parsedItems = parsedItems.length

    const econRows: Prisma.EconNews1dCreateManyInput[] = []
    const policyRows: Prisma.PolicyNews1dCreateManyInput[] = []
    const reportRows: Prisma.MacroReport1dCreateManyInput[] = []

    for (const item of parsedItems) {
      const eventDate = normalizeDateOnly(item.publishedAt || new Date())
      const rowHash = buildRowHash(feed.id, item, eventDate)
      const tags = [...new Set([...feed.tags, ...item.categories, `source_feed:${feed.id}`])]

      if (feed.kind === 'econ') {
        econRows.push(buildEconRow(feed, item, eventDate, rowHash, tags))
      } else {
        policyRows.push(buildPolicyRow(feed, item, eventDate, rowHash, tags))
      }

      if (feed.writeMacroReport) {
        reportRows.push(buildReportRow(feed, item, eventDate))
      }
    }

    if (econRows.length > 0) {
      feedStats.econInserted = await createManyBatched(econRows, async (batch) =>
        (await prisma.econNews1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
    if (policyRows.length > 0) {
      feedStats.policyInserted = await createManyBatched(policyRows, async (batch) =>
        (await prisma.policyNews1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
    if (reportRows.length > 0) {
      feedStats.reportInserted = await createManyBatched(reportRows, async (batch) =>
        (await prisma.macroReport1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    feedStats.errors.push(message.slice(0, 400))
  }

  return feedStats
}

export async function runIngestAltNewsFeeds(): Promise<RunStats> {
  loadDotEnvFiles()
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

  await upsertRegistry()

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'alt-news-rss-sync',
      status: 'RUNNING',
      details: toJson({ feedCount: FEEDS.length, feedIds: FEEDS.map((f) => f.id) }),
    },
  })

  const stats: RunStats = {
    feeds: {},
    totals: { fetchedItems: 0, parsedItems: 0, econInserted: 0, policyInserted: 0, reportInserted: 0 },
  }

  try {
    for (const feed of FEEDS) {
      const feedStats = await processAltNewsFeed(feed)
      stats.feeds[feed.id] = feedStats
      stats.totals.fetchedItems += feedStats.fetchedItems
      stats.totals.parsedItems += feedStats.parsedItems
      stats.totals.econInserted += feedStats.econInserted
      stats.totals.policyInserted += feedStats.policyInserted
      stats.totals.reportInserted += feedStats.reportInserted
    }

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        rowsProcessed: stats.totals.parsedItems,
        rowsInserted: stats.totals.econInserted + stats.totals.policyInserted + stats.totals.reportInserted,
        rowsFailed: Object.values(stats.feeds).reduce((acc, f) => acc + (f.errors.length ? 1 : 0), 0),
        details: toJson(stats),
      },
    })

    return stats
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        rowsFailed: 1,
        details: toJson({ error: message }),
      },
    })
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestAltNewsFeeds()
    .then((stats) => {
      console.log('[alt-news-rss] done')
      console.log(JSON.stringify(stats, null, 2))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[alt-news-rss] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
