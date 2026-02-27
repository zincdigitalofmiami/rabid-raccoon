import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

// ── Types ──────────────────────────────────────────────────────────

interface FeedConfig {
  id: string
  url: string
  source: string
  tags: string[]
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
  inserted: number
  errors: string[]
}

interface RunStats {
  feeds: Record<string, FeedStats>
  totals: {
    fetchedItems: number
    parsedItems: number
    inserted: number
  }
}

// ── Feed Configuration ─────────────────────────────────────────────

const FEEDS: FeedConfig[] = [
  {
    id: 'fred_announcements',
    url: 'https://news.research.stlouisfed.org/category/fred-announcements/feed/',
    source: 'fred_announcements',
    tags: ['fred', 'announcements', 'data-releases', 'stlouisfed'],
  },
  {
    id: 'fred_blog',
    url: 'https://fredblog.stlouisfed.org/feed/',
    source: 'fred_blog',
    tags: ['fred', 'blog', 'economic-research', 'stlouisfed'],
  },
]

const FETCH_TIMEOUT_MS = 20_000
const INSERT_BATCH_SIZE = 300

// ── Utility functions (same as ingest-alt-news-feeds.ts) ───────────

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

// ── Registry ───────────────────────────────────────────────────────

async function upsertRegistry(): Promise<void> {
  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'fred-news-rss-sync' },
    create: {
      sourceId: 'fred-news-rss-sync',
      sourceName: 'FRED News RSS Feeds',
      description: 'FRED Announcements + FRED Blog RSS feeds from St. Louis Fed.',
      targetTable: 'econ_news_1d',
      apiProvider: 'public-rss',
      updateFrequency: 'daily',
      ingestionScript: 'scripts/ingest-fred-news.ts',
      isActive: true,
    },
    update: {
      sourceName: 'FRED News RSS Feeds',
      description: 'FRED Announcements + FRED Blog RSS feeds from St. Louis Fed.',
      targetTable: 'econ_news_1d',
      apiProvider: 'public-rss',
      updateFrequency: 'daily',
      ingestionScript: 'scripts/ingest-fred-news.ts',
      isActive: true,
    },
  })
}

// ── Per-item mapping ───────────────────────────────────────────────

function itemToRow(feed: FeedConfig, item: ParsedItem): Prisma.EconNews1dCreateManyInput {
  const publishedAt = item.publishedAt
  const eventDate = normalizeDateOnly(publishedAt || new Date())
  const rowHash = buildRowHash(feed.id, item, eventDate)
  const tags = [...new Set([...feed.tags, ...item.categories, `source_feed:${feed.id}`])]

  return {
    articleId: item.articleId,
    eventDate,
    publishedAt,
    headline: item.title,
    summary: item.summary || item.content,
    content: item.content || item.summary,
    source: feed.source,
    author: item.author,
    url: item.link,
    topics: item.categories,
    subjects: [],
    tags,
    rowHash,
    rawPayload: toJson({ importedFrom: feed.url, feedId: feed.id }),
  }
}

// ── Per-feed processing ────────────────────────────────────────────

async function processFeed(feed: FeedConfig): Promise<FeedStats> {
  const feedStats: FeedStats = { fetchedItems: 0, parsedItems: 0, inserted: 0, errors: [] }

  try {
    console.log(`[fred-news-rss] fetching ${feed.id}: ${feed.url}`)
    const xml = await fetchFeedXml(feed.url)
    const parsedItems = parseRssLikeItems(xml)
    feedStats.fetchedItems = parsedItems.length
    feedStats.parsedItems = parsedItems.length
    console.log(`[fred-news-rss] ${feed.id}: parsed ${parsedItems.length} items`)

    const rows = parsedItems.map((item) => itemToRow(feed, item))

    if (rows.length > 0) {
      feedStats.inserted = await createManyBatched(rows, async (batch) =>
        (await prisma.econNews1d.createMany({ data: batch, skipDuplicates: true })).count
      )
    }

    console.log(`[fred-news-rss] ${feed.id}: inserted ${feedStats.inserted}/${rows.length}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    feedStats.errors.push(message.slice(0, 400))
    console.error(`[fred-news-rss] ${feed.id} FAILED: ${message}`)
  }

  return feedStats
}

// ── Ingestion run finalization ───────────────────────────────────

async function finalizeFredNewsRun(
  runId: bigint,
  stats: RunStats,
  feedCount: number
): Promise<void> {
  const feedsFailed = Object.values(stats.feeds).reduce((acc, f) => acc + (f.errors.length ? 1 : 0), 0)

  await prisma.ingestionRun.update({
    where: { id: runId },
    data: {
      status: feedsFailed === feedCount ? 'FAILED' : 'COMPLETED',
      finishedAt: new Date(),
      rowsProcessed: stats.totals.parsedItems,
      rowsInserted: stats.totals.inserted,
      rowsFailed: feedsFailed,
      details: toJson({
        ...stats,
        ...(feedsFailed > 0 && feedsFailed < feedCount ? {
          failedFeeds: Object.entries(stats.feeds)
            .filter(([, f]) => f.errors.length > 0)
            .map(([id, f]) => ({ id, errors: f.errors })),
        } : {}),
      }),
    },
  })
}

// ── Main ───────────────────────────────────────────────────────────

export async function runIngestFredNews(): Promise<RunStats> {
  loadDotEnvFiles()
  if (!process.env.LOCAL_DATABASE_URL && !process.env.DATABASE_URL && !process.env.DIRECT_URL) {
    throw new Error('LOCAL_DATABASE_URL, DATABASE_URL, or DIRECT_URL is required')
  }

  await upsertRegistry()

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'fred-news-rss-sync',
      status: 'RUNNING',
      details: toJson({ feedCount: FEEDS.length, feedIds: FEEDS.map((f) => f.id) }),
    },
  })

  const stats: RunStats = {
    feeds: {},
    totals: { fetchedItems: 0, parsedItems: 0, inserted: 0 },
  }

  try {
    for (const feed of FEEDS) {
      const feedStats = await processFeed(feed)
      stats.feeds[feed.id] = feedStats
      stats.totals.fetchedItems += feedStats.fetchedItems
      stats.totals.parsedItems += feedStats.parsedItems
      stats.totals.inserted += feedStats.inserted
    }

    await finalizeFredNewsRun(run.id, stats, FEEDS.length)
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

// ── CLI entrypoint ─────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestFredNews()
    .then((stats) => {
      console.log('[fred-news-rss] done')
      console.log(JSON.stringify(stats, null, 2))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[fred-news-rss] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
