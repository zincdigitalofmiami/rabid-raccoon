import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient
}

const databaseUrl = process.env.DATABASE_URL
const adapter = databaseUrl ? new PrismaPg({ connectionString: databaseUrl }) : undefined

const prismaClient =
  adapter &&
  (globalForPrisma.prisma ??
    new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    }))

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
