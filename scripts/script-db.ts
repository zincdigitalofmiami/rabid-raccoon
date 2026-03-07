import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { withAccelerate } from '@prisma/extension-accelerate'
import { loadDotEnvFiles } from './ingest-utils'

const SCRIPT_DB_ENV_PRIORITY = [
  'SCRIPT_DATABASE_URL',
  'LOCAL_DATABASE_URL',
  'DIRECT_URL',
  'DATABASE_URL',
] as const

const globalForScriptDb = globalThis as unknown as {
  scriptDbEnvLoaded?: boolean
  scriptPrisma?: PrismaClient
  scriptPrismaUrl?: string
}

function normalizeDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().replace(/(?:\\n|\n)+$/g, '')
  return normalized.length > 0 ? normalized : null
}

function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url)
}

function isAccelerateUrl(url: string): boolean {
  return /^prisma(\+postgres)?:\/\//i.test(url)
}

function ensureScriptEnvLoaded(): void {
  if (globalForScriptDb.scriptDbEnvLoaded) return
  loadDotEnvFiles()
  globalForScriptDb.scriptDbEnvLoaded = true
}

export function resolveScriptDatabaseUrl(): string {
  ensureScriptEnvLoaded()

  for (const envVar of SCRIPT_DB_ENV_PRIORITY) {
    const url = normalizeDatabaseUrl(process.env[envVar])
    if (url) return url
  }

  throw new Error(
    `No script database URL configured. Set one of: ${SCRIPT_DB_ENV_PRIORITY.join(', ')}`,
  )
}

export function getScriptPrismaClient(): PrismaClient {
  const url = resolveScriptDatabaseUrl()

  if (
    globalForScriptDb.scriptPrisma &&
    globalForScriptDb.scriptPrismaUrl === url
  ) {
    return globalForScriptDb.scriptPrisma
  }

  if (globalForScriptDb.scriptPrisma) {
    void globalForScriptDb.scriptPrisma.$disconnect()
  }

  let client: PrismaClient
  if (isPostgresUrl(url)) {
    const adapter = new PrismaPg({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
    })

    client = new PrismaClient({
      adapter,
      log: ['error'],
    })
  } else if (isAccelerateUrl(url)) {
    const base = new PrismaClient({
      accelerateUrl: url,
      log: ['error'],
    })
    client = base.$extends(withAccelerate()) as unknown as PrismaClient
  } else {
    throw new Error(
      `Unsupported script DB URL scheme. Expected postgres://, postgresql://, prisma://, or prisma+postgres:// (resolved from priority: ${SCRIPT_DB_ENV_PRIORITY.join(' -> ')})`,
    )
  }

  globalForScriptDb.scriptPrisma = client
  globalForScriptDb.scriptPrismaUrl = url
  return client
}

export async function disconnectScriptPrismaClient(): Promise<void> {
  if (!globalForScriptDb.scriptPrisma) return
  await globalForScriptDb.scriptPrisma.$disconnect()
  globalForScriptDb.scriptPrisma = undefined
  globalForScriptDb.scriptPrismaUrl = undefined
}
