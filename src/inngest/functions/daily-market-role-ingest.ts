import type { SymbolRoleKey } from '@/lib/symbol-registry/types'
import { getSymbolsByRole } from '@/lib/symbol-registry'
import { runIngestMarketPricesDaily } from '../../../scripts/ingest-market-prices-daily'

type StepRunner = {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>
}

export async function runDailyMarketIngestByRole(step: StepRunner, roleKey: SymbolRoleKey) {
  const symbols = (await getSymbolsByRole(roleKey)).map((symbol) => symbol.code)
  const results: Array<{
    symbol: string
    result: Awaited<ReturnType<typeof runIngestMarketPricesDaily>>
  }> = []

  for (const symbol of symbols) {
    const result = (await step.run(`market-prices-${symbol.toLowerCase()}`, async () =>
      runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false, symbols: [symbol] })
    )) as Awaited<ReturnType<typeof runIngestMarketPricesDaily>>
    results.push({ symbol, result })
  }

  return { ranAt: new Date().toISOString(), symbols, results }
}
