import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

async function run() {
    loadDotEnvFiles()
    const [futuresSymbols, totalCount] = await Promise.all([
        prisma.mktFutures1h.findMany({
            select: { symbolCode: true },
            distinct: ['symbolCode'],
            orderBy: { symbolCode: 'asc' },
        }),
        prisma.mktFutures1h.groupBy({
            by: ['symbolCode'],
            _count: { symbolCode: true },
        }),
    ])

    console.log('=== ALL AVAILABLE SYMBOLS IN DATABASE ===')
    console.log(`Total symbols in mkt_futures_1h: ${futuresSymbols.length}`)
    console.log('\nSymbols:')
    console.log(futuresSymbols.map((s) => s.symbolCode).join(', '))

    console.log('\n=== ROW COUNTS PER SYMBOL ===')
    const counts = totalCount.sort((a, b) => b._count.symbolCode - a._count.symbolCode)
    for (const c of counts.slice(0, 50)) {
        console.log(`${c.symbolCode.padEnd(10)} ${c._count.symbolCode.toLocaleString()} rows`)
    }
}

run()
    .catch((e) => {
        console.error(e)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
