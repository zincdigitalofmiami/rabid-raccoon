import { EconCategory } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

type DomainSpec = {
  name: string
  category: EconCategory
  fetchSeriesIds: () => Promise<string[]>
}

const DOMAIN_SPECS: DomainSpec[] = [
  {
    name: 'econ_rates_1d',
    category: 'RATES',
    fetchSeriesIds: async () => {
      const rows = await prisma.econRates1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_yields_1d',
    category: 'YIELDS',
    fetchSeriesIds: async () => {
      const rows = await prisma.econYields1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_fx_1d',
    category: 'FX',
    fetchSeriesIds: async () => {
      const rows = await prisma.econFx1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_vol_indices_1d',
    category: 'VOLATILITY',
    fetchSeriesIds: async () => {
      const rows = await prisma.econVolIndices1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_inflation_1d',
    category: 'INFLATION',
    fetchSeriesIds: async () => {
      const rows = await prisma.econInflation1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_labor_1d',
    category: 'LABOR',
    fetchSeriesIds: async () => {
      const rows = await prisma.econLabor1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_activity_1d',
    category: 'ACTIVITY',
    fetchSeriesIds: async () => {
      const rows = await prisma.econActivity1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_money_1d',
    category: 'MONEY',
    fetchSeriesIds: async () => {
      const rows = await prisma.econMoney1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
  {
    name: 'econ_commodities_1d',
    category: 'COMMODITIES',
    fetchSeriesIds: async () => {
      const rows = await prisma.econCommodities1d.findMany({ select: { seriesId: true }, distinct: ['seriesId'] })
      return rows.map((r) => r.seriesId)
    },
  },
]

const CATEGORY_PRIORITY: Record<EconCategory, number> = {
  RATES: 1,
  YIELDS: 2,
  FX: 3,
  VOLATILITY: 4,
  INFLATION: 5,
  LABOR: 6,
  ACTIVITY: 7,
  MONEY: 8,
  COMMODITIES: 9,
  EQUITY: 10,
  OTHER: 99,
}

function pickPreferredCategory(categories: Set<EconCategory>): EconCategory {
  return [...categories].sort((a, b) => CATEGORY_PRIORITY[a] - CATEGORY_PRIORITY[b])[0]
}

async function run() {
  loadDotEnvFiles()

  const dryRun = process.argv.includes('--dry-run')
  const fixCategory = process.argv.includes('--fix-category')

  const observedMap = new Map<string, Set<EconCategory>>()
  const observedByDomain: Record<string, number> = {}

  for (const spec of DOMAIN_SPECS) {
    const ids = await spec.fetchSeriesIds()
    observedByDomain[spec.name] = ids.length

    for (const id of ids) {
      const existing = observedMap.get(id)
      if (existing) {
        existing.add(spec.category)
      } else {
        observedMap.set(id, new Set([spec.category]))
      }
    }
  }

  const observedSeriesIds = [...observedMap.keys()].sort()

  const catalogRows = await prisma.economicSeries.findMany({
    select: { seriesId: true, category: true },
  })

  const catalogCategoryBySeries = new Map(catalogRows.map((row) => [row.seriesId, row.category]))
  const catalogSeriesIds = new Set(catalogRows.map((row) => row.seriesId))

  const missingInCatalog = observedSeriesIds.filter((id) => !catalogSeriesIds.has(id))
  const catalogWithoutData = [...catalogSeriesIds].filter((id) => !observedMap.has(id)).sort()

  const categoryMismatches = observedSeriesIds
    .filter((id) => catalogSeriesIds.has(id))
    .map((id) => {
      const observedCategory = pickPreferredCategory(observedMap.get(id)!)
      const catalogCategory = catalogCategoryBySeries.get(id)!
      return { seriesId: id, observedCategory, catalogCategory }
    })
    .filter((item) => item.observedCategory !== item.catalogCategory)

  let inserted = 0
  if (!dryRun && missingInCatalog.length > 0) {
    const rows = missingInCatalog.map((seriesId) => ({
      seriesId,
      displayName: seriesId,
      category: pickPreferredCategory(observedMap.get(seriesId)!),
      source: 'FRED' as const,
      sourceSymbol: seriesId,
      isActive: true,
      metadata: {
        reconciled: true,
        reconciledBy: 'scripts/reconcile-economic-series.ts',
      },
    }))

    inserted = (await prisma.economicSeries.createMany({ data: rows, skipDuplicates: true })).count
  }

  let categoriesUpdated = 0
  if (!dryRun && fixCategory && categoryMismatches.length > 0) {
    for (const mismatch of categoryMismatches) {
      await prisma.economicSeries.update({
        where: { seriesId: mismatch.seriesId },
        data: { category: mismatch.observedCategory },
      })
      categoriesUpdated += 1
    }
  }

  const collisions = [...observedMap.entries()]
    .filter(([, categories]) => categories.size > 1)
    .map(([seriesId, categories]) => ({ seriesId, categories: [...categories].sort() }))

  console.log(
    JSON.stringify(
      {
        dryRun,
        fixCategory,
        observedByDomain,
        observedDistinctSeriesCount: observedSeriesIds.length,
        catalogSeriesCount: catalogRows.length,
        missingInCatalogCount: missingInCatalog.length,
        missingInCatalog,
        catalogWithoutDataCount: catalogWithoutData.length,
        catalogWithoutData,
        categoryMismatchCount: categoryMismatches.length,
        categoryMismatches,
        multiDomainSeriesCount: collisions.length,
        multiDomainSeries: collisions,
        inserted,
        categoriesUpdated,
      },
      null,
      2
    )
  )
}

run()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    await prisma.$disconnect()
    process.exit(1)
  })
