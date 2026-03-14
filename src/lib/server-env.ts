import fs from 'node:fs'
import path from 'node:path'

const NORMALIZED_ENV_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'LOCAL_DATABASE_URL',
  'LOCAL_DEV',
  'PRISMA_LOCAL',
  'PRISMA_TARGET',
  'USE_ACCELERATE',
] as const

const ENV_FILES = ['.env.production.local', '.env.local', '.env'] as const

let envFilesLoaded = false

export function normalizeEnvValue(value?: string | null): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().replace(/(?:\\n|\n)+$/g, '')
  return normalized.length > 0 ? normalized : undefined
}

function loadServerEnvFiles(): void {
  if (envFilesLoaded) return
  envFilesLoaded = true

  for (const rel of ENV_FILES) {
    const envPath = path.resolve(process.cwd(), rel)
    if (!fs.existsSync(envPath)) continue

    const lines = fs.readFileSync(envPath, 'utf8').split('\n')
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue

      const eq = line.indexOf('=')
      if (eq <= 0) continue

      const key = line.slice(0, eq).trim()
      if (process.env[key]) continue

      const rawValue = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
      const value = normalizeEnvValue(rawValue)
      if (value) process.env[key] = value
    }
  }
}

export function normalizeServerEnv(): void {
  loadServerEnvFiles()

  for (const key of NORMALIZED_ENV_KEYS) {
    const normalized = normalizeEnvValue(process.env[key])
    if (normalized) process.env[key] = normalized
  }
}

export function resolveDatabaseTarget(): 'local' | 'direct' {
  normalizeServerEnv()

  const explicitTarget = normalizeEnvValue(process.env.PRISMA_TARGET)?.toLowerCase()
  if (explicitTarget === 'local' || explicitTarget === 'direct') {
    return explicitTarget
  }

  if (normalizeEnvValue(process.env.PRISMA_LOCAL) === '1') return 'local'
  if (normalizeEnvValue(process.env.LOCAL_DEV) === '1') return 'local'

  return 'direct'
}

export function resolveDirectDatabaseUrl(): string | undefined {
  normalizeServerEnv()

  const directUrl = normalizeEnvValue(process.env.DIRECT_URL)
  const localUrl = normalizeEnvValue(process.env.LOCAL_DATABASE_URL)

  return resolveDatabaseTarget() === 'local'
    ? localUrl ?? directUrl
    : directUrl ?? localUrl
}

function isAccelerateUrl(url: string): boolean {
  return /^prisma(\+postgres)?:\/\//i.test(url)
}

export function resolveRuntimeDatabaseUrl(): string | undefined {
  normalizeServerEnv()

  const directResolved = resolveDirectDatabaseUrl()
  if (directResolved) return directResolved

  const runtimeUrl = normalizeEnvValue(process.env.DATABASE_URL)
  if (!runtimeUrl) return undefined

  const forceAccelerate = normalizeEnvValue(process.env.USE_ACCELERATE) === '1'
  if (isAccelerateUrl(runtimeUrl)) {
    return forceAccelerate ? runtimeUrl : undefined
  }

  return runtimeUrl
}

export function hasRuntimeDatabaseUrl(): boolean {
  return Boolean(resolveRuntimeDatabaseUrl())
}
