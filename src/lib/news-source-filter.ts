/**
 * Source quality filter for news scraping.
 * Blocks spam domains and non-English content.
 */

const TRUSTED_SOURCES = new Set([
  'reuters', 'bloomberg', 'cnbc', 'wsj', 'wall street journal',
  'financial times', 'ft', 'barrons', 'marketwatch', 'ap news',
  'associated press', 'new york times', 'nyt', 'washington post',
  'bbc', 'cnn', 'fox business', 'yahoo finance', 'seeking alpha',
  'politico', 'axios', 'fortune', 'business insider', 'the economist',
  'investopedia', 'benzinga', 'zacks', 'morningstar', 'thestreet',
])

const BLOCKED_TLD_PATTERNS = ['.ru', '.vn', '.cn', '.ir', '.kp']

/**
 * Check if a news source/domain is acceptable.
 * Trusted sources pass immediately, blocked TLDs are rejected,
 * everything else passes through.
 */
export function isAcceptableSource(source: string): boolean {
  const lower = source.toLowerCase().trim()

  // Check trusted
  for (const trusted of TRUSTED_SOURCES) {
    if (lower.includes(trusted)) return true
  }

  // Check blocked TLDs
  for (const tld of BLOCKED_TLD_PATTERNS) {
    if (lower.endsWith(tld)) return false
  }

  return true
}

/**
 * Reject titles with >30% non-Latin characters (Cyrillic, CJK, Vietnamese diacritics, etc.)
 */
export function isEnglishTitle(title: string): boolean {
  if (!title || title.length === 0) return false
  // Count characters that are basic Latin, digits, punctuation, or common accented Latin
  const latinChars = title.replace(/[\u0000-\u007F\u00C0-\u024F\u1E00-\u1EFF]/g, '')
  return latinChars.length / title.length < 0.3
}

/**
 * Combined check: source is acceptable AND title is English.
 */
export function isQualityArticle(source: string, title: string): boolean {
  return isAcceptableSource(source) && isEnglishTitle(title)
}
