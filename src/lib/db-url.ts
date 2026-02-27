type DbKind = 'prisma-runtime' | 'direct-pg'
type DbSource = 'LOCAL_DATABASE_URL' | 'DIRECT_URL' | 'DATABASE_URL'

export interface ResolvedDbTarget {
  kind: DbKind
  source: DbSource
  url: string
  protocol: string
  host: string
}

const loggedTargets = new Set<string>()

export function requireEnv(name: DbSource): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required but not set`)
  }
  return value
}

function parseTarget(url: string): { protocol: string; host: string } {
  try {
    const parsed = new URL(url)
    return {
      protocol: parsed.protocol.replace(/:$/, ''),
      host: parsed.host || 'unknown',
    }
  } catch {
    return { protocol: 'unknown', host: 'unknown' }
  }
}

function buildTarget(kind: DbKind, source: DbSource, url: string): ResolvedDbTarget {
  const parsed = parseTarget(url)
  return {
    kind,
    source,
    url,
    protocol: parsed.protocol,
    host: parsed.host,
  }
}

export function resolvePrismaRuntimeUrl(): ResolvedDbTarget {
  const isProd = process.env.NODE_ENV === 'production'
  const local = process.env.LOCAL_DATABASE_URL
  const database = process.env.DATABASE_URL

  if (!isProd && local) {
    return buildTarget('prisma-runtime', 'LOCAL_DATABASE_URL', local)
  }
  if (database) {
    return buildTarget('prisma-runtime', 'DATABASE_URL', database)
  }
  if (local) {
    return buildTarget('prisma-runtime', 'LOCAL_DATABASE_URL', local)
  }
  throw new Error(
    'Prisma runtime URL resolution failed: expected LOCAL_DATABASE_URL (dev) or DATABASE_URL.'
  )
}

export function resolveDirectPgUrl(): ResolvedDbTarget {
  const local = process.env.LOCAL_DATABASE_URL
  if (local) return buildTarget('direct-pg', 'LOCAL_DATABASE_URL', local)

  const direct = process.env.DIRECT_URL
  if (direct) return buildTarget('direct-pg', 'DIRECT_URL', direct)

  throw new Error(
    'Direct pg URL resolution failed: expected LOCAL_DATABASE_URL (local-first) or DIRECT_URL (direct Postgres).'
  )
}

export function describeDbTarget(target: ResolvedDbTarget): string {
  return JSON.stringify({
    kind: target.kind,
    source: target.source,
    protocol: target.protocol,
    host: target.host,
    mode: process.env.NODE_ENV || 'unknown',
  })
}

export function logResolvedDbTarget(scope: string, target: ResolvedDbTarget): void {
  const key = `${scope}:${target.kind}:${target.source}:${target.host}`
  if (loggedTargets.has(key)) return
  loggedTargets.add(key)
  console.info(`[db-target] ${scope} ${describeDbTarget(target)}`)
}
