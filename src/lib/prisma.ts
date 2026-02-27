import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { withAccelerate } from '@prisma/extension-accelerate'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
  prismaUrl?: string
}

function getPrismaClient(): PrismaClient {
  // Local dev uses LOCAL_DATABASE_URL (local Postgres) — keeps Accelerate
  // operations for Vercel production only, zero cost during development.
  // Batch scripts and ingestion pipelines connect via DIRECT_URL directly,
  // bypassing Accelerate entirely (no per-op cost, no 5s timeout).
  const localUrl = process.env.NODE_ENV !== 'production' ? process.env.LOCAL_DATABASE_URL : undefined
  const databaseUrl = localUrl || process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured; Prisma client is unavailable')
  }

  if (globalForPrisma.prisma && globalForPrisma.prismaUrl === databaseUrl) {
    return globalForPrisma.prisma
  }

  const usePgAdapter = /^postgres(ql)?:\/\//i.test(databaseUrl)
  const useAccelerateUrl = /^prisma(\+postgres)?:\/\//i.test(databaseUrl)
  const adapter = usePgAdapter ? new PrismaPg({ connectionString: databaseUrl }) : undefined

  const baseClient = new PrismaClient({
    ...(adapter ? { adapter } : {}),
    ...(useAccelerateUrl ? { accelerateUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

  const client = useAccelerateUrl
    ? (baseClient.$extends(withAccelerate()) as unknown as PrismaClient)
    : baseClient

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
    globalForPrisma.prismaUrl = databaseUrl
  }

  return client
}

const prismaProxy = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrismaClient()
    const value = Reflect.get(client, prop, receiver)
    return typeof value === 'function' ? value.bind(client) : value
  },
})

export const prisma: PrismaClient = prismaProxy
