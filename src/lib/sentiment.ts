const BULLISH_TERMS = [
  'rally',
  'surge',
  'soar',
  'beat',
  'exceeded expectations',
  'dovish',
  'rate cut',
  'stimulus',
  'easing',
  'jobs beat',
  'trade deal',
  'ceasefire',
]

const BEARISH_TERMS = [
  'crash',
  'plunge',
  'selloff',
  'collapse',
  'missed expectations',
  'hawkish',
  'rate hike',
  'recession',
  'tightening',
  'layoffs',
  'jobs miss',
  'trade war',
  'sanctions',
  'tariff',
  'escalation',
  'detention',
  'deportation',
  'vix spike',
  'panic',
]

const HIGH_IMPACT_SOURCES = [
  'reuters',
  'bloomberg',
  'cnbc',
  'wsj',
  'wall street journal',
  'financial times',
  'ft',
  'associated press',
  'ap',
  'federal reserve',
  'bls',
  'white house',
]

function countHits(text: string, terms: string[]): number {
  let count = 0
  for (const term of terms) {
    if (text.includes(term)) count += 1
  }
  return count
}

export function scoreSentiment(title: string, source: string | null | undefined): {
  sentiment: number
  relevance: number
} {
  const normalizedTitle = title.toLowerCase()
  const normalizedSource = (source || '').toLowerCase()

  const bullCount = countHits(normalizedTitle, BULLISH_TERMS)
  const bearCount = countHits(normalizedTitle, BEARISH_TERMS)
  const total = bullCount + bearCount

  const sentiment = total === 0 ? 0 : (bullCount - bearCount) / total
  const isHighImpact = HIGH_IMPACT_SOURCES.some((s) => normalizedSource.includes(s))
  const relevance = Math.min(1, total * 0.25 + (isHighImpact ? 0.3 : 0))

  return {
    sentiment: Number(sentiment.toFixed(4)),
    relevance: Number(relevance.toFixed(4)),
  }
}
