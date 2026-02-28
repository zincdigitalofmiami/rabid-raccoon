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
  const forceLocal = process.env.PRISMA_LOCAL === '1'
  const forceDirect = process.env.PRISMA_DIRECT === '1'
  const local = process.env.LOCAL_DATABASE_URL
  const direct = process.env.DIRECT_URL
  const database = process.env.DATABASE_URL

  if (forceLocal && forceDirect) {
    throw new Error('DB URL resolution failed: PRISMA_LOCAL and PRISMA_DIRECT cannot both be 1.')
  }
  if (forceDirect) {
    if (direct) {
      return buildTarget('prisma-runtime', 'DIRECT_URL', direct)
    }
    throw new Error('Prisma runtime URL resolution failed: PRISMA_DIRECT=1 requires DIRECT_URL.')
  }
  if (forceLocal) {
    if (local) {
      return buildTarget('prisma-runtime', 'LOCAL_DATABASE_URL', local)
    }
    throw new Error('Prisma runtime URL resolution failed: PRISMA_LOCAL=1 requires LOCAL_DATABASE_URL.')
  }

  if (isProd) {
    if (database) {
      return buildTarget('prisma-runtime', 'DATABASE_URL', database)
    }
    throw new Error(
      'Prisma runtime URL resolution failed in production: DATABASE_URL is required.'
    )
  }

  if (!isProd) {
    if (local) {
      return buildTarget('prisma-runtime', 'LOCAL_DATABASE_URL', local)
    }
    throw new Error(
      'Prisma runtime URL resolution failed in non-production: LOCAL_DATABASE_URL is required by default. To bypass local-first explicitly, set PRISMA_DIRECT=1 with DIRECT_URL.'
    )
  }

  throw new Error('Prisma runtime URL resolution failed: unresolved configuration state.')
}

export function resolveDirectPgUrl(): ResolvedDbTarget {
  const isProd = process.env.NODE_ENV === 'production'
  const forceLocal = process.env.PRISMA_LOCAL === '1'
  const forceDirect = process.env.PRISMA_DIRECT === '1'
  const local = process.env.LOCAL_DATABASE_URL
  const direct = process.env.DIRECT_URL

  if (forceLocal && forceDirect) {
    throw new Error('Direct pg URL resolution failed: PRISMA_LOCAL and PRISMA_DIRECT cannot both be 1.')
  }
  if (forceDirect) {
    if (direct) return buildTarget('direct-pg', 'DIRECT_URL', direct)
    throw new Error('Direct pg URL resolution failed: PRISMA_DIRECT=1 requires DIRECT_URL.')
  }
  if (forceLocal) {
    if (local) return buildTarget('direct-pg', 'LOCAL_DATABASE_URL', local)
    throw new Error('Direct pg URL resolution failed: PRISMA_LOCAL=1 requires LOCAL_DATABASE_URL.')
  }

  if (isProd) {
    if (direct) return buildTarget('direct-pg', 'DIRECT_URL', direct)
    throw new Error(
      'Direct pg URL resolution failed in production: DIRECT_URL is required.'
    )
  }

  if (!isProd) {
    if (local) return buildTarget('direct-pg', 'LOCAL_DATABASE_URL', local)
    throw new Error(
      'Direct pg URL resolution failed in non-production: LOCAL_DATABASE_URL is required by default. To use direct Postgres explicitly, set PRISMA_DIRECT=1 with DIRECT_URL.'
    )
  }

  throw new Error('Direct pg URL resolution failed: unresolved configuration state.')
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
