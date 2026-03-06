/**
 * tiered-cache.ts — Multi-tier in-memory TTL cache
 *
 * Three tiers:
 *   - Morning-stable: FRED headlines, fed funds, macro features (4h TTL)
 *   - Intraday: News volume, correlation scores (60s TTL)
 *   - Signal: Full scored signal from Inngest compute cycle (15m TTL)
 *
 * Follows the forecast-cache.ts pattern: simple Map, no Redis.
 */

type CacheTier = 'morning' | 'intraday' | 'signal'

const TTL_MS: Record<CacheTier, number> = {
  morning: 4 * 60 * 60 * 1000,    // 4 hours
  intraday: 60 * 1000,             // 60 seconds
  signal: 16 * 60 * 1000,          // 16 minutes (1m buffer over 15m cron cycle)
}

interface CacheEntry<T> {
  data: T
  storedAt: number
  tier: CacheTier
}

const store = new Map<string, CacheEntry<unknown>>()

function makeKey(tier: CacheTier, key: string): string {
  return `${tier}:${key}`
}

/**
 * Get a cached value. Returns null if missing or expired.
 */
export function getCache<T>(tier: CacheTier, key: string): T | null {
  const fullKey = makeKey(tier, key)
  const entry = store.get(fullKey) as CacheEntry<T> | undefined
  if (!entry) return null

  const age = Date.now() - entry.storedAt
  if (age > TTL_MS[entry.tier]) {
    store.delete(fullKey)
    return null
  }

  return entry.data
}

/**
 * Store a value in the cache.
 */
export function setCache<T>(tier: CacheTier, key: string, data: T): void {
  const fullKey = makeKey(tier, key)
  store.set(fullKey, { data, storedAt: Date.now(), tier })
}

/**
 * Invalidate a specific cache entry.
 */
export function invalidateCache(tier: CacheTier, key: string): void {
  store.delete(makeKey(tier, key))
}

/**
 * Invalidate all entries in a tier.
 */
export function invalidateTier(tier: CacheTier): void {
  const prefix = `${tier}:`
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) {
      store.delete(k)
    }
  }
}

/**
 * Prune expired entries across all tiers. Called periodically to bound memory.
 */
export function pruneExpired(): void {
  const now = Date.now()
  for (const [k, entry] of store.entries()) {
    if (now - entry.storedAt > TTL_MS[entry.tier]) {
      store.delete(k)
    }
  }
}

/**
 * Get-or-fetch pattern: return cached value or compute and cache it.
 */
export async function getCacheOrFetch<T>(
  tier: CacheTier,
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = getCache<T>(tier, key)
  if (cached !== null) return cached

  const data = await fetcher()
  setCache(tier, key, data)
  return data
}

// Convenience aliases
export const morningCache = {
  get: <T>(key: string) => getCache<T>('morning', key),
  set: <T>(key: string, data: T) => setCache('morning', key, data),
  getOrFetch: <T>(key: string, fn: () => Promise<T>) => getCacheOrFetch('morning', key, fn),
}

export const intradayCache = {
  get: <T>(key: string) => getCache<T>('intraday', key),
  set: <T>(key: string, data: T) => setCache('intraday', key, data),
  getOrFetch: <T>(key: string, fn: () => Promise<T>) => getCacheOrFetch('intraday', key, fn),
}

export const signalCache = {
  get: <T>(key: string) => getCache<T>('signal', key),
  set: <T>(key: string, data: T) => setCache('signal', key, data),
  getOrFetch: <T>(key: string, fn: () => Promise<T>) => getCacheOrFetch('signal', key, fn),
}
