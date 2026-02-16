import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ECON_REPORT_QUERIES } from '@/lib/news-queries'
import { fetchGoogleNewsRss } from '@/lib/google-news'
import { isQualityArticle } from '@/lib/news-source-filter'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function GET() {
  try {
    const now = new Date()
    const utcDay = now.getUTCDay() // 0 Sun .. 6 Sat
    if (utcDay === 0 || utcDay === 6) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'weekend' })
    }

    let queriesRun = 0
    let articlesSeen = 0
    let filtered = 0
    let inserted = 0
    let updated = 0

    for (const q of ECON_REPORT_QUERIES) {
      const items = await fetchGoogleNewsRss(q.query)
      queriesRun += 1
      articlesSeen += items.length

      for (const item of items) {
        if (!isQualityArticle(item.source || '', item.title)) {
          filtered += 1
          continue
        }

        const existing = await prisma.newsSignal.findUnique({ where: { link: item.link }, select: { id: true } })

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

      await sleep(2000)
    }

    return NextResponse.json({ ok: true, queriesRun, articlesSeen, filtered, inserted, updated })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
