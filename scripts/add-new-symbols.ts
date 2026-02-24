import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

async function run() {
  loadDotEnvFiles()

  // Add ZT (2-Year T-Note)
  await prisma.symbol.upsert({
    where: { code: 'ZT' },
    create: {
      code: 'ZT',
      displayName: 'ZT',
      shortName: '2Y Note',
      description: '2-Year Treasury Note Futures',
      tickSize: 0.0078125,
      dataSource: 'DATABENTO',
      dataset: 'GLBX.MDP3',
      databentoSymbol: 'ZT.c.0',
      isActive: true,
    },
    update: { isActive: true, dataSource: 'DATABENTO', dataset: 'GLBX.MDP3', databentoSymbol: 'ZT.c.0' },
  })
  console.log('ZT created/activated')

  // Add ZQ (30-Day Fed Funds)
  await prisma.symbol.upsert({
    where: { code: 'ZQ' },
    create: {
      code: 'ZQ',
      displayName: 'ZQ',
      shortName: 'Fed Funds',
      description: '30-Day Federal Funds Futures',
      tickSize: 0.005,
      dataSource: 'DATABENTO',
      dataset: 'GLBX.MDP3',
      databentoSymbol: 'ZQ.c.0',
      isActive: true,
    },
    update: { isActive: true, dataSource: 'DATABENTO', dataset: 'GLBX.MDP3', databentoSymbol: 'ZQ.c.0' },
  })
  console.log('ZQ created/activated')

  // Add SR1 (1-Month SOFR)
  await prisma.symbol.upsert({
    where: { code: 'SR1' },
    create: {
      code: 'SR1',
      displayName: 'SR1',
      shortName: 'SOFR 1M',
      description: '1-Month SOFR Futures',
      tickSize: 0.0025,
      dataSource: 'DATABENTO',
      dataset: 'GLBX.MDP3',
      databentoSymbol: 'SR1.c.0',
      isActive: true,
    },
    update: { isActive: true, dataSource: 'DATABENTO', dataset: 'GLBX.MDP3', databentoSymbol: 'SR1.c.0' },
  })
  console.log('SR1 created/activated')

  // Activate MNQ
  await prisma.symbol.update({
    where: { code: 'MNQ' },
    data: { isActive: true },
  })
  console.log('MNQ activated')

  // Activate MYM
  await prisma.symbol.update({
    where: { code: 'MYM' },
    data: { isActive: true },
  })
  console.log('MYM activated')

  // Verify
  const active = await prisma.symbol.findMany({
    where: { dataSource: 'DATABENTO', isActive: true },
    select: { code: true, databentoSymbol: true },
    orderBy: { code: 'asc' },
  })
  console.log('\nAll active DATABENTO symbols:')
  for (const s of active) {
    console.log(`  ${s.code.padEnd(6)} → ${s.databentoSymbol}`)
  }
  console.log(`\nTotal: ${active.length}`)
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
