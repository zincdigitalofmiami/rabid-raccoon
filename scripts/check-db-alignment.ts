/**
 * check-db-alignment.ts
 *
 * Verifies that every table the lean dataset builder pulls from
 * has actual data, with row counts, date ranges, and series breakdowns.
 *
 * Usage:
 *   npx tsx scripts/check-db-alignment.ts
 */

import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

loadDotEnvFiles()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(d: Date | null | undefined): string {
  if (!d) return '(none)'
  return d.toISOString().slice(0, 10)
}

function fmtTs(d: Date | null | undefined): string {
  if (!d) return '(none)'
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function section(title: string) {
  console.log('')
  console.log('═'.repeat(70))
  console.log(`  ${title}`)
  console.log('═'.repeat(70))
}

function row(label: string, value: string | number) {
  console.log(`  ${label.padEnd(28)} ${value}`)
}

// ─── Econ series table helper ─────────────────────────────────────────────────

async function checkEconTable(
  label: string,
  tableName: string,
  expectedSeries: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delegate: any,
) {
  section(label)

  const total = await delegate.count()
  row('Total rows', total.toLocaleString())

  if (total === 0) {
    console.log('  *** EMPTY TABLE ***')
    return
  }

  const earliest = await delegate.findFirst({ orderBy: { eventDate: 'asc' }, select: { eventDate: true } })
  const latest = await delegate.findFirst({ orderBy: { eventDate: 'desc' }, select: { eventDate: true } })
  row('Earliest date', fmt(earliest?.eventDate))
  row('Latest date', fmt(latest?.eventDate))

  // Group by seriesId
  const groups = await delegate.groupBy({
    by: ['seriesId'],
    _count: { id: true },
    orderBy: { seriesId: 'asc' },
  })

  console.log('')
  console.log('  Series breakdown:')
  const foundSeries = new Set<string>()
  for (const g of groups) {
    foundSeries.add(g.seriesId)
    const needed = expectedSeries.includes(g.seriesId) ? '' : ' (not needed by builder)'
    // Get date range for this series
    const seriesEarliest = await delegate.findFirst({
      where: { seriesId: g.seriesId },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true },
    })
    const seriesLatest = await delegate.findFirst({
      where: { seriesId: g.seriesId },
      orderBy: { eventDate: 'desc' },
      select: { eventDate: true },
    })
    console.log(
      `    ${g.seriesId.padEnd(20)} ${String(g._count.id).padStart(8)} rows   ${fmt(seriesEarliest?.eventDate)} → ${fmt(seriesLatest?.eventDate)}${needed}`,
    )
  }

  // Check for missing series
  const missing = expectedSeries.filter((s) => !foundSeries.has(s))
  if (missing.length > 0) {
    console.log('')
    console.log(`  *** MISSING SERIES: ${missing.join(', ')} ***`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Rabid Raccoon — Database Alignment Check')
  console.log(`Run at: ${new Date().toISOString()}`)

  // ── 1. mkt_futures_mes_1h ──────────────────────────────────────────────────
  section('1. mkt_futures_mes_1h — MES 1h OHLCV candles')
  {
    const total = await prisma.mktFuturesMes1h.count()
    row('Total rows', total.toLocaleString())
    if (total > 0) {
      const earliest = await prisma.mktFuturesMes1h.findFirst({ orderBy: { eventTime: 'asc' }, select: { eventTime: true } })
      const latest = await prisma.mktFuturesMes1h.findFirst({ orderBy: { eventTime: 'desc' }, select: { eventTime: true } })
      row('Earliest', fmtTs(earliest?.eventTime))
      row('Latest', fmtTs(latest?.eventTime))
    } else {
      console.log('  *** EMPTY TABLE ***')
    }
  }

  // ── 2. mkt_futures_1h — Cross-asset futures ────────────────────────────────
  section('2. mkt_futures_1h — Cross-asset futures (NQ, ZN, CL, 6E, 6J, NG)')
  {
    const total = await prisma.mktFutures1h.count()
    row('Total rows', total.toLocaleString())
    if (total > 0) {
      const earliest = await prisma.mktFutures1h.findFirst({ orderBy: { eventTime: 'asc' }, select: { eventTime: true } })
      const latest = await prisma.mktFutures1h.findFirst({ orderBy: { eventTime: 'desc' }, select: { eventTime: true } })
      row('Earliest', fmtTs(earliest?.eventTime))
      row('Latest', fmtTs(latest?.eventTime))

      const groups = await prisma.mktFutures1h.groupBy({
        by: ['symbolCode'],
        _count: { id: true },
        orderBy: { symbolCode: 'asc' },
      })
      console.log('')
      console.log('  Symbol breakdown:')
      const expectedSymbols = ['NQ', 'ZN', 'CL', '6E', '6J', 'NG']
      const foundSymbols = new Set<string>()
      for (const g of groups) {
        foundSymbols.add(g.symbolCode)
        const needed = expectedSymbols.includes(g.symbolCode) ? '' : ' (not needed by builder)'
        const symEarliest = await prisma.mktFutures1h.findFirst({
          where: { symbolCode: g.symbolCode },
          orderBy: { eventTime: 'asc' },
          select: { eventTime: true },
        })
        const symLatest = await prisma.mktFutures1h.findFirst({
          where: { symbolCode: g.symbolCode },
          orderBy: { eventTime: 'desc' },
          select: { eventTime: true },
        })
        console.log(
          `    ${g.symbolCode.padEnd(10)} ${String(g._count.id).padStart(8)} rows   ${fmtTs(symEarliest?.eventTime)} → ${fmtTs(symLatest?.eventTime)}${needed}`,
        )
      }
      const missingSymbols = expectedSymbols.filter((s) => !foundSymbols.has(s))
      if (missingSymbols.length > 0) {
        console.log(`  *** MISSING SYMBOLS: ${missingSymbols.join(', ')} ***`)
      }
    } else {
      console.log('  *** EMPTY TABLE ***')
    }
  }

  // ── 3. econ_rates_1d ───────────────────────────────────────────────────────
  await checkEconTable(
    '3. econ_rates_1d — FRED rates',
    'econ_rates_1d',
    ['DFF', 'SOFR', 'DFEDTARL', 'DFEDTARU'],
    prisma.econRates1d,
  )

  // ── 4. econ_yields_1d ──────────────────────────────────────────────────────
  await checkEconTable(
    '4. econ_yields_1d — FRED yields',
    'econ_yields_1d',
    ['DGS2', 'DGS10', 'DGS30'],
    prisma.econYields1d,
  )

  // ── 5. econ_fx_1d ──────────────────────────────────────────────────────────
  await checkEconTable(
    '5. econ_fx_1d — FRED FX',
    'econ_fx_1d',
    ['DTWEXBGS', 'DEXUSEU', 'DEXJPUS'],
    prisma.econFx1d,
  )

  // ── 6. econ_vol_indices_1d ─────────────────────────────────────────────────
  await checkEconTable(
    '6. econ_vol_indices_1d — FRED vol + credit',
    'econ_vol_indices_1d',
    ['VIXCLS', 'BAMLC0A0CM', 'BAMLH0A0HYM2'],
    prisma.econVolIndices1d,
  )

  // ── 7. econ_inflation_1d ───────────────────────────────────────────────────
  await checkEconTable(
    '7. econ_inflation_1d — FRED inflation',
    'econ_inflation_1d',
    ['DFII10'],
    prisma.econInflation1d,
  )

  // ── 8. econ_labor_1d ───────────────────────────────────────────────────────
  await checkEconTable(
    '8. econ_labor_1d — FRED labor',
    'econ_labor_1d',
    ['ICSA'],
    prisma.econLabor1d,
  )

  // ── 9. econ_money_1d ───────────────────────────────────────────────────────
  await checkEconTable(
    '9. econ_money_1d — FRED money/liquidity',
    'econ_money_1d',
    ['WALCL', 'RRPONTSYD'],
    prisma.econMoney1d,
  )

  // ── 10. econ_commodities_1d ────────────────────────────────────────────────
  await checkEconTable(
    '10. econ_commodities_1d — FRED commodities',
    'econ_commodities_1d',
    ['DCOILWTICO', 'PCOPPUSDM'],
    prisma.econCommodities1d,
  )

  // ── 11. econ_calendar ──────────────────────────────────────────────────────
  section('11. econ_calendar — Event calendar')
  {
    const total = await prisma.econCalendar.count()
    row('Total rows', total.toLocaleString())
    if (total > 0) {
      const earliest = await prisma.econCalendar.findFirst({ orderBy: { eventDate: 'asc' }, select: { eventDate: true } })
      const latest = await prisma.econCalendar.findFirst({ orderBy: { eventDate: 'desc' }, select: { eventDate: true } })
      row('Earliest date', fmt(earliest?.eventDate))
      row('Latest date', fmt(latest?.eventDate))

      // Impact rating breakdown
      const impactGroups = await prisma.econCalendar.groupBy({
        by: ['impactRating'],
        _count: { id: true },
        orderBy: { impactRating: 'asc' },
      })
      console.log('')
      console.log('  Impact rating breakdown:')
      for (const g of impactGroups) {
        console.log(`    ${(g.impactRating ?? '(null)').padEnd(20)} ${String(g._count.id).padStart(8)} events`)
      }

      // Event type breakdown
      const typeGroups = await prisma.econCalendar.groupBy({
        by: ['eventType'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      })
      console.log('')
      console.log('  Event type breakdown (top 10):')
      for (const g of typeGroups.slice(0, 10)) {
        console.log(`    ${g.eventType.padEnd(30)} ${String(g._count.id).padStart(8)} events`)
      }
    } else {
      console.log('  *** EMPTY TABLE ***')
    }
  }

  // ── 12. news_signals ───────────────────────────────────────────────────────
  section('12. news_signals — News headlines')
  {
    const total = await prisma.newsSignal.count()
    row('Total rows', total.toLocaleString())
    if (total > 0) {
      const earliest = await prisma.newsSignal.findFirst({ orderBy: { pubDate: 'asc' }, select: { pubDate: true } })
      const latest = await prisma.newsSignal.findFirst({ orderBy: { pubDate: 'desc' }, select: { pubDate: true } })
      row('Earliest pubDate', fmtTs(earliest?.pubDate))
      row('Latest pubDate', fmtTs(latest?.pubDate))

      const layerGroups = await prisma.newsSignal.groupBy({
        by: ['layer'],
        _count: { id: true },
        orderBy: { layer: 'asc' },
      })
      console.log('')
      console.log('  Layer breakdown:')
      for (const g of layerGroups) {
        console.log(`    ${g.layer.padEnd(20)} ${String(g._count.id).padStart(8)} signals`)
      }

      const catGroups = await prisma.newsSignal.groupBy({
        by: ['category'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      })
      console.log('')
      console.log('  Category breakdown (top 10):')
      for (const g of catGroups.slice(0, 10)) {
        console.log(`    ${g.category.padEnd(20)} ${String(g._count.id).padStart(8)} signals`)
      }
    } else {
      console.log('  *** EMPTY TABLE ***')
    }
  }

  // ── 13. econ_news_1d ───────────────────────────────────────────────────────
  section('13. econ_news_1d — Economic news articles')
  {
    const total = await prisma.econNews1d.count()
    row('Total rows', total.toLocaleString())
    if (total > 0) {
      const earliest = await prisma.econNews1d.findFirst({ orderBy: { eventDate: 'asc' }, select: { eventDate: true } })
      const latest = await prisma.econNews1d.findFirst({ orderBy: { eventDate: 'desc' }, select: { eventDate: true } })
      row('Earliest date', fmt(earliest?.eventDate))
      row('Latest date', fmt(latest?.eventDate))
    } else {
      console.log('  *** EMPTY TABLE ***')
    }
  }

  // ── 14. policy_news_1d ─────────────────────────────────────────────────────
  section('14. policy_news_1d — Policy news')
  {
    const total = await prisma.policyNews1d.count()
    row('Total rows', total.toLocaleString())
    if (total > 0) {
      const earliest = await prisma.policyNews1d.findFirst({ orderBy: { eventDate: 'asc' }, select: { eventDate: true } })
      const latest = await prisma.policyNews1d.findFirst({ orderBy: { eventDate: 'desc' }, select: { eventDate: true } })
      row('Earliest date', fmt(earliest?.eventDate))
      row('Latest date', fmt(latest?.eventDate))
    } else {
      console.log('  *** EMPTY TABLE ***')
    }
  }

  // ── 15. bhg_setups ─────────────────────────────────────────────────────────
  section('15. bhg_setups — BHG setup tracking')
  {
    const total = await prisma.bhgSetup.count()
    row('Total rows', total.toLocaleString())
    if (total > 0) {
      const earliest = await prisma.bhgSetup.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true, goTime: true } })
      const latest = await prisma.bhgSetup.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, goTime: true } })
      row('Earliest createdAt', fmtTs(earliest?.createdAt))
      row('Latest createdAt', fmtTs(latest?.createdAt))

      const phaseGroups = await prisma.bhgSetup.groupBy({
        by: ['phase'],
        _count: { id: true },
        orderBy: { phase: 'asc' },
      })
      console.log('')
      console.log('  Phase breakdown:')
      for (const g of phaseGroups) {
        console.log(`    ${g.phase.padEnd(20)} ${String(g._count.id).padStart(8)} setups`)
      }

      const dirGroups = await prisma.bhgSetup.groupBy({
        by: ['direction'],
        _count: { id: true },
        orderBy: { direction: 'asc' },
      })
      console.log('')
      console.log('  Direction breakdown:')
      for (const g of dirGroups) {
        console.log(`    ${g.direction.padEnd(20)} ${String(g._count.id).padStart(8)} setups`)
      }
    } else {
      console.log('  *** EMPTY TABLE ***')
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  section('SUMMARY')
  console.log('  Check complete. Review any *** EMPTY TABLE *** or *** MISSING *** warnings above.')
  console.log('')
}

main()
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
  .then(() => {
    process.exit(0)
  })
