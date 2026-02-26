import { inngest } from '../client'
import { prisma } from '../../lib/prisma'
import { SYMBOL_REGISTRY_SNAPSHOT } from '../../lib/symbol-registry/snapshot'
import { fetchOhlcv, toCandles } from '../../lib/databento'

const HISTORY_DAYS = 730
const MIN_COVERAGE_PCT = 95
const EXPECTED_DAILY_BARS = Math.floor((HISTORY_DAYS * 5) / 7) // 521
const MIN_REQUIRED_BARS = Math.floor(EXPECTED_DAILY_BARS * (MIN_COVERAGE_PCT / 100)) // 494
const FETCH_TIMEOUT_MS = 120_000
const INGESTION_ACTIVE_ROLE = 'INGESTION_ACTIVE'

interface CoverageResult {
  symbolCode: string
  actualBars: number
  expectedBars: number
  coveragePct: number
  passesThreshold: boolean
  wasActivated: boolean
  error?: string
}

function getInactiveDatabentoSymbols() {
  return SYMBOL_REGISTRY_SNAPSHOT.symbols.filter(
    (s) => !s.isActive && s.dataSource === 'DATABENTO' && s.databentoSymbol && s.dataset
  )
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null
  try {
    return (await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms)
      }),
    ])) as T
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function tryActivateSymbol(symbolCode: string): Promise<boolean> {
  try {
    // Check if a role member already exists for INGESTION_ACTIVE
    const existing = await prisma.symbolRoleMember.findUnique({
      where: { roleKey_symbolCode: { roleKey: INGESTION_ACTIVE_ROLE, symbolCode } },
    })

    if (existing) {
      if (!existing.enabled) {
        await prisma.symbolRoleMember.update({
          where: { id: existing.id },
          data: { enabled: true },
        })
        console.log(`[coverage-check] ACTIVATED ${symbolCode} — enabled existing INGESTION_ACTIVE membership`)
        return true
      }
      // Already enabled — shouldn't happen for inactive symbols, but don't error
      console.log(`[coverage-check] ${symbolCode} already has enabled INGESTION_ACTIVE membership`)
      return false
    }

    // Find the next position for the role
    const maxPos = await prisma.symbolRoleMember.aggregate({
      where: { roleKey: INGESTION_ACTIVE_ROLE },
      _max: { position: true },
    })
    const nextPosition = (maxPos._max.position ?? -1) + 1

    await prisma.symbolRoleMember.create({
      data: {
        roleKey: INGESTION_ACTIVE_ROLE,
        symbolCode,
        position: nextPosition,
        enabled: true,
      },
    })

    // Also activate the Symbol record itself
    await prisma.symbol.update({
      where: { code: symbolCode },
      data: { isActive: true },
    })

    console.log(`[coverage-check] ACTIVATED ${symbolCode} — created INGESTION_ACTIVE membership at position ${nextPosition}`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[coverage-check] Failed to activate ${symbolCode}: ${message}`)
    return false
  }
}

/**
 * Weekly Databento coverage re-audit for inactive symbols.
 * Checks all inactive DATABENTO symbols against the 95% / 730-day threshold.
 * Auto-activates in DB if coverage passes (deploy required for snapshot to update).
 * Logs results to coverage_check_log table.
 * Runs weekly on Sundays at 06:00 UTC.
 */
export const checkSymbolCoverage = inngest.createFunction(
  { id: 'check-symbol-coverage', retries: 1 },
  { cron: '0 6 * * 0' },
  async ({ step }) => {
    const inactiveSymbols = getInactiveDatabentoSymbols()

    if (inactiveSymbols.length === 0) {
      console.log('[coverage-check] No inactive DATABENTO symbols found — skipping')
      return { ranAt: new Date().toISOString(), symbolsChecked: 0, results: [] }
    }

    const run = await step.run('create-ingestion-run', async () => {
      const record = await prisma.ingestionRun.create({
        data: {
          job: 'check-symbol-coverage',
          status: 'RUNNING',
          details: {
            symbolCount: inactiveSymbols.length,
            symbols: inactiveSymbols.map((s) => s.code),
            historyDays: HISTORY_DAYS,
            minCoveragePct: MIN_COVERAGE_PCT,
            expectedDailyBars: EXPECTED_DAILY_BARS,
            minRequiredBars: MIN_REQUIRED_BARS,
          },
        },
      })
      return { id: Number(record.id) }
    })

    try {
      const results: CoverageResult[] = []
      const activated: string[] = []

      for (const symbol of inactiveSymbols) {
        const result = await step.run(`coverage-${symbol.code.toLowerCase()}`, async () => {
          const now = new Date()
          const start = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
          // Cap end 30min behind now to avoid Databento 422 on recent data
          const end = new Date(now.getTime() - 30 * 60 * 1000)

          let actualBars = 0
          let error: string | undefined

          try {
            const records = await withTimeout(
              fetchOhlcv({
                dataset: symbol.dataset!,
                symbol: symbol.databentoSymbol!,
                stypeIn: 'continuous',
                start: start.toISOString(),
                end: end.toISOString(),
                schema: 'ohlcv-1d',
              }),
              FETCH_TIMEOUT_MS,
              `Databento ${symbol.code} ohlcv-1d`
            )
            const candles = toCandles(records)
            actualBars = candles.length
          } catch (err) {
            error = (err instanceof Error ? err.message : String(err)).slice(0, 500)
            console.error(`[coverage-check] ${symbol.code} fetch failed: ${error}`)
          }

          const coveragePct = EXPECTED_DAILY_BARS > 0
            ? Math.round((actualBars / EXPECTED_DAILY_BARS) * 10000) / 100
            : 0
          const passesThreshold = actualBars >= MIN_REQUIRED_BARS && !error

          let wasActivated = false
          if (passesThreshold) {
            wasActivated = await tryActivateSymbol(symbol.code)
          }

          // Log to coverage_check_log
          await prisma.coverageCheckLog.create({
            data: {
              symbolCode: symbol.code,
              historyDays: HISTORY_DAYS,
              expectedBars: EXPECTED_DAILY_BARS,
              actualBars,
              coveragePct,
              passesThreshold,
              thresholdPct: MIN_COVERAGE_PCT,
              wasActivated,
              error: error ?? null,
              metadata: JSON.parse(JSON.stringify({
                databentoSymbol: symbol.databentoSymbol,
                dataset: symbol.dataset,
                displayName: symbol.displayName,
                minRequiredBars: MIN_REQUIRED_BARS,
              })),
            },
          })

          const status = error
            ? 'ERROR'
            : passesThreshold
              ? (wasActivated ? 'PASS+ACTIVATED' : 'PASS')
              : 'BELOW_THRESHOLD'
          console.log(
            `[coverage-check] ${symbol.code}: ${actualBars}/${EXPECTED_DAILY_BARS} bars (${coveragePct}%) — ${status}`
          )

          return {
            symbolCode: symbol.code,
            actualBars,
            expectedBars: EXPECTED_DAILY_BARS,
            coveragePct,
            passesThreshold,
            wasActivated,
            error,
          } satisfies CoverageResult
        })

        results.push(result)
        if (result.wasActivated) activated.push(result.symbolCode)
      }

      const passed = results.filter((r) => r.passesThreshold)
      const failed = results.filter((r) => !r.passesThreshold && !r.error)
      const errored = results.filter((r) => r.error)

      if (activated.length > 0) {
        console.log(
          `[coverage-check] SYMBOLS ACTIVATED (deploy required for ingestion): ${activated.join(', ')}`
        )
      }

      console.log(
        `[coverage-check] Complete — ${results.length} checked, ${passed.length} pass, ${failed.length} below threshold, ${errored.length} errors, ${activated.length} activated`
      )

      await step.run('update-ingestion-run', async () => {
        await prisma.ingestionRun.update({
          where: { id: BigInt(run.id) },
          data: {
            status: errored.length === results.length ? 'FAILED' : 'COMPLETED',
            finishedAt: new Date(),
            rowsProcessed: results.length,
            rowsInserted: activated.length,
            rowsFailed: errored.length,
            details: JSON.parse(JSON.stringify({
              historyDays: HISTORY_DAYS,
              minCoveragePct: MIN_COVERAGE_PCT,
              symbolsChecked: results.length,
              passed: passed.map((r) => r.symbolCode),
              belowThreshold: failed.map((r) => ({ code: r.symbolCode, pct: r.coveragePct })),
              errored: errored.map((r) => ({ code: r.symbolCode, error: r.error })),
              activated,
              results,
            })),
          },
        })
      })

      return {
        ranAt: new Date().toISOString(),
        symbolsChecked: results.length,
        passed: passed.length,
        belowThreshold: failed.length,
        errored: errored.length,
        activated,
        results,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await prisma.ingestionRun.update({
          where: { id: BigInt(run.id) },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            details: { error: message },
          },
        })
      } catch { /* IngestionRun update failed — original error takes priority */ }
      throw error
    }
  }
)
