import { prisma } from "../src/lib/prisma"
import { loadDotEnvFiles } from "./ingest-utils"

loadDotEnvFiles()

async function run() {
  // Per-year row counts for problem symbols + MES baseline
  for (const sym of ["MES_1H", "6J", "6E", "ZN", "GC", "SI", "SOX", "ES", "NQ", "CL"]) {
    console.log(`\n=== ${sym} ===`)
    for (const year of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
      const start = new Date(`${year}-01-01T00:00:00Z`)
      const end = new Date(`${year + 1}-01-01T00:00:00Z`)
      let count: number
      if (sym === "MES_1H") {
        count = await prisma.mktFuturesMes1h.count({
          where: { eventTime: { gte: start, lt: end } }
        })
      } else {
        count = await prisma.mktFutures1h.count({
          where: { symbolCode: sym, eventTime: { gte: start, lt: end } }
        })
      }
      if (count > 0) {
        const expected = year === 2026 ? 1100 : 6200 // ~252 trading days * ~24.6 hours
        const pct = ((count / expected) * 100).toFixed(0)
        console.log(`  ${year}: ${count.toLocaleString()} rows (${pct}% of expected)`)
      }
    }
  }

  await prisma.$disconnect()
}

run()
