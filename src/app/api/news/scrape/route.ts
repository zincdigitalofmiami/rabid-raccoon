import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { queriesForLayer } from '@/lib/news-queries'
import { scoreSentiment } from '@/lib/sentiment'
import { fetchGoogleNewsRss } from '@/lib/google-news'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function utcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const layer = url.searchParams.get('layer') || undefined
    const selected = queriesForLayer(layer)

    if (selected.length === 0) {
      return NextResponse.json({ ok: false, error: `No queries for layer='${layer}'` }, { status: 400 })
    }

    let queriesRun = 0
    let articlesSeen = 0
    let inserted = 0
    let updated = 0

    for (const q of selected) {
      const items = await fetchGoogleNewsRss(q.query)
      queriesRun += 1
      articlesSeen += items.length

      for (const item of items) {
        const sentiment = scoreSentiment(item.title, item.source)
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
            sentimentScore: sentiment.sentiment,
            relevanceScore: sentiment.relevance,
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
            sentimentScore: sentiment.sentiment,
            relevanceScore: sentiment.relevance,
          },
        })

        if (existing) updated += 1
        else inserted += 1
      }

      // Google News politeness delay.
      await sleep(2000)
    }

    return NextResponse.json({
      ok: true,
      layer: layer || 'all',
      queriesRun,
      articlesSeen,
      inserted,
      updated,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
