export interface ParsedNewsItem {
  title: string
  link: string
  pubDate: Date
  source: string | null
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function clean(value: string | null): string | null {
  if (!value) return null
  const trimmed = decodeEntities(value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')).trim()
  return trimmed.length ? trimmed : null
}

function firstTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
  return clean(m?.[1] || null)
}

function atomLink(xml: string): string | null {
  const m = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)
  return clean(m?.[1] || null)
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null
  const dt = new Date(raw)
  return Number.isFinite(dt.getTime()) ? dt : null
}

function normalizeSource(raw: string | null, title: string): string | null {
  if (raw && raw.length > 0) return raw
  const parts = title.split(' - ')
  if (parts.length >= 2) return parts[parts.length - 1].trim()
  return null
}

export function parseGoogleNewsRss(xml: string): ParsedNewsItem[] {
  const items: ParsedNewsItem[] = []

  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || []
  for (const raw of rssItems) {
    const title = firstTag(raw, 'title')
    const link = firstTag(raw, 'link')
    const pub = parseDate(firstTag(raw, 'pubDate'))
    const source = normalizeSource(firstTag(raw, 'source'), title || '')
    if (!title || !link || !pub) continue
    items.push({ title, link, pubDate: pub, source })
  }

  if (items.length > 0) return items

  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || []
  for (const raw of atomEntries) {
    const title = firstTag(raw, 'title')
    const link = atomLink(raw)
    const pub = parseDate(firstTag(raw, 'published') || firstTag(raw, 'updated'))
    const source = normalizeSource(firstTag(raw, 'source'), title || '')
    if (!title || !link || !pub) continue
    items.push({ title, link, pubDate: pub, source })
  }

  return items
}

export async function fetchGoogleNewsRss(query: string): Promise<ParsedNewsItem[]> {
  const url = new URL('https://news.google.com/rss/search')
  url.searchParams.set('q', `${query} when:1d`)
  url.searchParams.set('hl', 'en-US')
  url.searchParams.set('gl', 'US')
  url.searchParams.set('ceid', 'US:en')

  const res = await fetch(url.toString(), {
    cache: 'no-store',
    headers: {
      'User-Agent': 'RabidRaccoon/1.0',
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Google News RSS ${res.status}: ${body.slice(0, 200)}`)
  }

  const xml = await res.text()
  return parseGoogleNewsRss(xml)
}
