import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
}

const databaseUrl = process.env.DATABASE_URL
const usePgAdapter = !!databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl)
const useAccelerateUrl = !!databaseUrl && /^prisma(\+postgres)?:\/\//i.test(databaseUrl)
const adapter = usePgAdapter ? new PrismaPg({ connectionString: databaseUrl }) : undefined

const prismaClient = databaseUrl
  ? globalForPrisma.prisma ??
    new PrismaClient({
      ...(adapter ? { adapter } : {}),
      ...(useAccelerateUrl ? { accelerateUrl: databaseUrl } : {}),
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    })
  : undefined

if (prismaClient && process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prismaClient
}

const prismaMissingProxy = new Proxy(
  {},
  {
    get() {
      throw new Error('DATABASE_URL is not configured; Prisma client is unavailable')
    },
  }
) as PrismaClient

export const prisma: PrismaClient = prismaClient ?? prismaMissingProxy
