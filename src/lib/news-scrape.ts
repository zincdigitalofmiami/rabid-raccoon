import { prisma } from '@/lib/prisma'
import { queriesForLayer } from '@/lib/news-queries'
import { fetchGoogleNewsRss } from '@/lib/google-news'
import { isQualityArticle } from '@/lib/news-source-filter'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function utcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export interface NewsScrapeResult {
  ok: boolean
  layer: string
  queriesRun: number
  articlesSeen: number
  filtered: number
  inserted: number
  updated: number
  queryErrors: Array<{ query: string; error: string }>
}

export interface NewsScrapeOptions {
  layer?: string
  continueOnError?: boolean
  queryDelayMs?: number
}

interface NormalizedNewsScrapeOptions {
  layer?: string
  continueOnError: boolean
  queryDelayMs: number
}

function normalizeOptions(input?: string | NewsScrapeOptions): NormalizedNewsScrapeOptions {
  if (typeof input === 'string') {
    return { layer: input, continueOnError: false, queryDelayMs: 2000 }
  }
  return {
    layer: input?.layer,
    continueOnError: input?.continueOnError ?? false,
    queryDelayMs: input?.queryDelayMs ?? 2000,
  }
}

export async function runNewsScrape(input?: string | NewsScrapeOptions): Promise<NewsScrapeResult> {
  const options = normalizeOptions(input)
  const selected = queriesForLayer(options.layer)

  if (selected.length === 0) {
    throw new Error(`No queries for layer='${options.layer}'`)
  }

  let queriesRun = 0
  let articlesSeen = 0
  let filtered = 0
  let inserted = 0
  let updated = 0
  const queryErrors: Array<{ query: string; error: string }> = []

  for (const q of selected) {
    try {
      const items = await fetchGoogleNewsRss(q.query)
      queriesRun += 1
      articlesSeen += items.length

      for (const item of items) {
        if (!isQualityArticle(item.source || '', item.title)) {
          filtered += 1
          continue
        }

        const existing = await prisma.newsSignal.findUnique({
          where: { link: item.link },
          select: { id: true },
        })

        await prisma.newsSignal.upsert({
          where: { link: item.link },
          create: {
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            source: item.source,
            query: q.query,
            layer: q.layer,
            category: q.category,
            metadata: {
              eventDate: utcDateOnly(item.pubDate).toISOString().slice(0, 10),
            },
          },
          update: {
            title: item.title,
            pubDate: item.pubDate,
            source: item.source,
            query: q.query,
            layer: q.layer,
            category: q.category,
          },
        })

        if (existing) updated += 1
        else inserted += 1
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      queryErrors.push({ query: q.query, error: message.slice(0, 400) })
      if (!options.continueOnError) throw error
    } finally {
      await sleep(options.queryDelayMs)
    }
  }

  return {
    ok: true,
    layer: options.layer || 'all',
    queriesRun,
    articlesSeen,
    filtered,
    inserted,
    updated,
    queryErrors,
  }
}
