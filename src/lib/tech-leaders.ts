export interface TechLeaderDefinition {
  symbol: string
  name: string
}

export interface TechLeaderSnapshot {
  symbol: string
  name: string
  price: number
  dayChangePercent: number
  weekChangePercent: number
}

// Broad mega-cap/AI-heavy basket that drives a large share of SPX directional flows.
export const TOP_AI_TECH_COMPANIES: TechLeaderDefinition[] = [
  { symbol: 'MSFT', name: 'Microsoft' },
  { symbol: 'AAPL', name: 'Apple' },
  { symbol: 'NVDA', name: 'NVIDIA' },
  { symbol: 'AMZN', name: 'Amazon' },
  { symbol: 'GOOGL', name: 'Alphabet' },
  { symbol: 'META', name: 'Meta' },
  { symbol: 'AVGO', name: 'Broadcom' },
  { symbol: 'TSLA', name: 'Tesla' },
  { symbol: 'ORCL', name: 'Oracle' },
  { symbol: 'AMD', name: 'AMD' },
]

export async function fetchTechLeaderSnapshots(): Promise<TechLeaderSnapshot[]> {
  // FRED does not provide direct per-ticker intraday/daily pricing for these equities.
  // To avoid mixing non-FRED sources, return no per-company snapshots for now.
  return []
}
