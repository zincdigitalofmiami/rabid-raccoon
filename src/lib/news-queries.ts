export interface NewsQuery {
  query: string
  layer: 'trump_policy' | 'volatility' | 'banking' | 'econ_report'
  category: string
}

const TRUMP_POLICY: NewsQuery[] = [
  { query: 'Trump executive order', layer: 'trump_policy', category: 'executive_order' },
  { query: 'Trump tariff', layer: 'trump_policy', category: 'tariff' },
  { query: 'Trump trade war', layer: 'trump_policy', category: 'tariff' },
  { query: 'Trump sanctions', layer: 'trump_policy', category: 'tariff' },
  { query: 'ICE detention deportation', layer: 'trump_policy', category: 'immigration' },
  { query: 'Trump immigration enforcement', layer: 'trump_policy', category: 'immigration' },
  { query: 'Trump border', layer: 'trump_policy', category: 'immigration' },
  { query: 'Trump lawsuit suing', layer: 'trump_policy', category: 'legal' },
  { query: 'Trump DOJ investigation', layer: 'trump_policy', category: 'legal' },
  { query: 'Trump military strike', layer: 'trump_policy', category: 'military' },
  { query: 'Trump fired cabinet', layer: 'trump_policy', category: 'personnel' },
  { query: 'Trump nomination appointment', layer: 'trump_policy', category: 'personnel' },
  { query: 'Trump tax bill', layer: 'trump_policy', category: 'economic_policy' },
  { query: 'Trump deregulation', layer: 'trump_policy', category: 'economic_policy' },
  { query: 'Trump Fed pressure rate cut', layer: 'trump_policy', category: 'economic_policy' },
]

const VOLATILITY: NewsQuery[] = [
  { query: 'VIX spike fear', layer: 'volatility', category: 'vix' },
  { query: 'market crash selloff', layer: 'volatility', category: 'selloff' },
  { query: 'market rally record high', layer: 'volatility', category: 'rally' },
  { query: 'stock market volatility', layer: 'volatility', category: 'volatility' },
  { query: 'credit spreads widening', layer: 'volatility', category: 'credit_spreads' },
]

const BANKING: NewsQuery[] = [
  { query: 'bank earnings results', layer: 'banking', category: 'earnings' },
  { query: 'JPMorgan Goldman Sachs earnings', layer: 'banking', category: 'earnings' },
  { query: 'bank stress test', layer: 'banking', category: 'stress_test' },
  { query: 'banking crisis regional bank', layer: 'banking', category: 'bank_stress' },
  { query: 'FDIC bank failure', layer: 'banking', category: 'bank_stress' },
]

const ECON_REPORT: NewsQuery[] = [
  { query: 'CPI forecast expectations', layer: 'econ_report', category: 'cpi' },
  { query: 'NFP forecast nonfarm payrolls expectations', layer: 'econ_report', category: 'nfp' },
  { query: 'FOMC rate decision forecast', layer: 'econ_report', category: 'fomc' },
  { query: 'PCE inflation forecast', layer: 'econ_report', category: 'pce' },
  { query: 'GDP forecast expectations', layer: 'econ_report', category: 'gdp' },
  { query: 'PPI forecast expectations', layer: 'econ_report', category: 'ppi' },
  { query: 'jobless claims forecast', layer: 'econ_report', category: 'claims' },
  { query: 'retail sales forecast', layer: 'econ_report', category: 'retail' },
  { query: 'ISM PMI forecast', layer: 'econ_report', category: 'ism' },
  { query: 'CPI report market reaction', layer: 'econ_report', category: 'cpi' },
  { query: 'NFP report beat miss', layer: 'econ_report', category: 'nfp' },
  { query: 'FOMC decision market reaction', layer: 'econ_report', category: 'fomc' },
]

export const NEWS_QUERIES: NewsQuery[] = [
  ...TRUMP_POLICY,
  ...VOLATILITY,
  ...BANKING,
  ...ECON_REPORT,
]

export function queriesForLayer(layer?: string): NewsQuery[] {
  if (!layer) return NEWS_QUERIES
  return NEWS_QUERIES.filter((item) => item.layer === layer)
}

export const ECON_REPORT_QUERIES: NewsQuery[] = ECON_REPORT
