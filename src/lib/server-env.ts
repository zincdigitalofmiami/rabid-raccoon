import fs from 'node:fs'
import path from 'node:path'

const NORMALIZED_ENV_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'LOCAL_DATABASE_URL',
  'LOCAL_DEV',
  'DATABENTO_API_KEY',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'PRISMA_LOCAL',
  'PRISMA_TARGET',
  'RRInngest_INNGEST_EVENT_KEY',
  'RRInngest_INNGEST_SIGNING_KEY',
] as const

const ENV_FILES = ['.env.production.local', '.env.local', '.env'] as const

const ENV_ALIASES = [
  ['INNGEST_EVENT_KEY', 'RRInngest_INNGEST_EVENT_KEY'],
  ['INNGEST_SIGNING_KEY', 'RRInngest_INNGEST_SIGNING_KEY'],
] as const

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
      if (value) {
        process.env[key] = value
      }
    }
  }
}

export function normalizeServerEnv(): void {
  loadServerEnvFiles()

  for (const key of NORMALIZED_ENV_KEYS) {
    const normalized = normalizeEnvValue(process.env[key])
    if (normalized) {
      process.env[key] = normalized
    }
  }

  for (const [canonicalKey, legacyKey] of ENV_ALIASES) {
    const canonicalValue = normalizeEnvValue(process.env[canonicalKey])
    if (canonicalValue) {
      process.env[canonicalKey] = canonicalValue
      continue
    }

    const legacyValue = normalizeEnvValue(process.env[legacyKey])
    if (legacyValue) {
      process.env[canonicalKey] = legacyValue
    }
  }
}

export function resolveDatabaseTarget(): 'local' | 'direct' {
  normalizeServerEnv()

  const explicitTarget = normalizeEnvValue(process.env.PRISMA_TARGET)?.toLowerCase()
  if (explicitTarget === 'local' || explicitTarget === 'direct') {
    return explicitTarget
  }

  if (normalizeEnvValue(process.env.PRISMA_LOCAL) === '1') {
    return 'local'
  }

  if (normalizeEnvValue(process.env.LOCAL_DEV) === '1') {
    return 'local'
  }

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

export function resolveRuntimeDatabaseUrl(): string | undefined {
  normalizeServerEnv()
  return resolveDirectDatabaseUrl() ?? normalizeEnvValue(process.env.DATABASE_URL)
}

export function hasRuntimeDatabaseUrl(): boolean {
  return Boolean(resolveRuntimeDatabaseUrl())
}
