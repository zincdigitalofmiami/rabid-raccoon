import { prisma } from "../src/lib/prisma"
import { loadDotEnvFiles } from "./ingest-utils"

loadDotEnvFiles()

async function run() {
  // BHG setups
  try {
    const bhg = await prisma.bhgSetup.count()
    console.log("bhg_setups:", bhg)
  } catch(e) { console.log("bhg_setups: TABLE NOT FOUND") }

  // News signals  
  try {
    const ns = await prisma.newsSignal.count()
    console.log("news_signals:", ns)
  } catch(e) { console.log("news_signals: TABLE NOT FOUND") }

  // Calendar
  const cal = await prisma.econCalendar.count()
  console.log("econ_calendar:", cal)

  // Macro reports
  const mr = await prisma.macroReport1d.count()
  console.log("macro_report_1d:", mr)

  // MES 1h date range
  const first = await prisma.mktFuturesMes1h.findFirst({ orderBy: { eventTime: "asc" }, select: { eventTime: true } })
  const last = await prisma.mktFuturesMes1h.findFirst({ orderBy: { eventTime: "desc" }, select: { eventTime: true } })
  console.log("mes_1h range:", first?.eventTime, "to", last?.eventTime)

  // Cross-asset date ranges for problem symbols
  for (const sym of ["6J", "6E", "ZN", "GC", "SI", "SOX"]) {
    const f = await prisma.mktFutures1h.findFirst({ where: { symbolCode: sym }, orderBy: { eventTime: "asc" }, select: { eventTime: true } })
    const l = await prisma.mktFutures1h.findFirst({ where: { symbolCode: sym }, orderBy: { eventTime: "desc" }, select: { eventTime: true } })
    const c = await prisma.mktFutures1h.count({ where: { symbolCode: sym } })
    console.log(`${sym}: ${c} rows, ${f?.eventTime} to ${l?.eventTime}`)
  }

  await prisma.$disconnect()
}

run()
