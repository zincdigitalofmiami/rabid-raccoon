import { toNum } from '@/lib/decimal'
import {
  MES_1M_OWNER_PATH,
  readLatestMes1mRows,
  readMes1mFreshnessSnapshot,
  type Mes1mFreshnessSnapshot,
} from '@/lib/mes-live-queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface MesPricePoint {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

interface MesRow {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

interface Mes1mRow {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

const JSON_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
}
const SOURCE_TABLE = MES_1M_OWNER_PATH.sourceTable
const STALE_AFTER_SECONDS = 20 * 60

type RouteMode = 'poll' | 'snapshot'
type Mes1mOwnerMode = 'inngest' | 'worker'
type OwnerLagState = 'on-time' | 'lagging' | 'no-recent-rows' | 'market-closed' | 'unknown'
type FreshnessAttribution =
  | 'owner-path-healthy'
  | 'owner-path-freshness-lag'
  | 'no-recent-1m-rows'
  | 'reader-path-runtime-failure'
  | 'market-closed'
  | 'owner-path-telemetry-unavailable'

interface LiveMesOwnerPathMeta {
  writerFunctionId: string
  writerFunctionFile: string
  writerPath: string
  ownerMode: Mes1mOwnerMode
  upstreamProvider: string
  sourceTable: string
  expectedCadenceSeconds: number
  lagAlertSeconds: number
  marketOpen: boolean
  latest1mRowTime: string | null
  latest1mRowAgeSeconds: number | null
  rowsLast5m: number | null
  rowsLast15m: number | null
  rowsLast60m: number | null
  freshnessLagSeconds: number | null
  lagState: OwnerLagState
  telemetryAvailable: boolean
}

interface LiveMesMeta {
  status: 'fresh' | 'stale' | 'empty-source' | 'runtime-failure'
  attribution: FreshnessAttribution
  mode: RouteMode
  source: string
  requestedBars: number
  sourceBarCount: number
  latestBarTime: string | null
  sourceAgeSeconds: number | null
  staleAfterSeconds: number
  isStale: boolean | null
  ownerPath: LiveMesOwnerPathMeta
  updatedAt: string
}

function asPoint(row: MesRow): MesPricePoint {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

/**
 * CME Globex MES session: Sunday 5 PM CT → Friday 4 PM CT.
 * Bars outside this window are closed-market artifacts — filter them out.
 *
 * CT offsets: CST = UTC-6 (Nov–Mar), CDT = UTC-5 (Mar–Nov).
 * We use conservative UTC boundaries that work for both DST states.
 */
function isWeekendBar(date: Date): boolean {
  const day = date.getUTCDay()   // 0=Sun, 6=Sat
  const hour = date.getUTCHours()

  // Saturday: always closed
  if (day === 6) return true

  // Sunday before 22:00 UTC (covers CDT open at 22:00 and CST open at 23:00)
  if (day === 0 && hour < 22) return true

  // Friday after 22:00 UTC (covers CST close at 22:00 and CDT close at 21:00)
  if (day === 5 && hour >= 22) return true

  return false
}

function rowFingerprint(row: MesRow): string {
  return [
    row.eventTime.getTime(),
    toNum(row.open),
    toNum(row.high),
    toNum(row.low),
    toNum(row.close),
    row.volume == null ? 0 : Number(row.volume),
  ].join('|')
}

const FIFTEEN_MIN_SECONDS = 15 * 60
const POLL_MIN_1M_LOOKBACK = 240
const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193

function updateFnv1a32(hash: number, value: string): number {
  let next = hash
  for (let i = 0; i < value.length; i++) {
    next ^= value.charCodeAt(i)
    next = Math.imul(next, FNV_PRIME_32)
  }
  return next >>> 0
}

function pollRowsFingerprint(rows: MesRow[]): string {
  let hash = FNV_OFFSET_BASIS_32
  for (const row of rows) {
    hash = updateFnv1a32(hash, rowFingerprint(row))
    hash = updateFnv1a32(hash, '\n')
  }
  const lastTimeMs = rows[rows.length - 1]?.eventTime.getTime() ?? 0
  return `${rows.length}:${lastTimeMs}:${hash.toString(16)}`
}

function sanitize1mRows(rows: Mes1mRow[]): Mes1mRow[] {
  if (rows.length === 0) return []
  const sorted = [...rows].sort(
    (a, b) => a.eventTime.getTime() - b.eventTime.getTime()
  )
  const clean: Mes1mRow[] = []
  let prevClose: number | null = null

  for (const row of sorted) {
    const o = toNum(row.open)
    const h = toNum(row.high)
    const l = toNum(row.low)
    const c = toNum(row.close)

    // Base OHLC sanity
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue
    if (h < l) continue
    // 1m range sanity: reject pathological ticks
    if ((h - l) / Math.max(o, 1) > 0.08) continue

    if (prevClose != null && prevClose > 0) {
      // continuity sanity against prior clean close
      if (Math.abs(o - prevClose) / prevClose > 0.08) continue
      if (Math.abs(c - prevClose) / prevClose > 0.08) continue
      if (h > prevClose * 1.12) continue
      if (l < prevClose * 0.88) continue
    }

    clean.push(row)
    prevClose = c
  }

  return clean
}

function aggregateTo15mFrom1m(rows: Mes1mRow[]): MesRow[] {
  if (rows.length === 0) return []
  const sorted = sanitize1mRows(rows)
  if (sorted.length === 0) return []
  const out: MesRow[] = []

  let bucketStartSec = -1
  let bucket: MesRow | null = null

  for (const row of sorted) {
    const sec = Math.floor(row.eventTime.getTime() / 1000)
    const alignedSec = Math.floor(sec / FIFTEEN_MIN_SECONDS) * FIFTEEN_MIN_SECONDS
    const alignedTime = new Date(alignedSec * 1000)

    if (!bucket || alignedSec !== bucketStartSec) {
      if (bucket) out.push(bucket)
      bucketStartSec = alignedSec
      bucket = {
        eventTime: alignedTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      }
      continue
    }

    bucket.high = Math.max(toNum(bucket.high), toNum(row.high))
    bucket.low = Math.min(toNum(bucket.low), toNum(row.low))
    bucket.close = row.close
    const prevVol = bucket.volume == null ? 0 : bucket.volume
    const nextVol = row.volume == null ? 0 : row.volume
    bucket.volume = prevVol + nextVol
  }

  if (bucket) out.push(bucket)
  return out
}

async function loadSnapshotRows(backfillCount: number): Promise<MesRow[]> {
  const oneMinuteBackfill = Math.max(backfillCount * 15 + 240, 2400)
  const initial1m = await readLatestMes1mRows(oneMinuteBackfill)

  const initial = aggregateTo15mFrom1m(initial1m).slice(-backfillCount)

  return [...initial]
    .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
    .filter((r) => !isWeekendBar(r.eventTime))
}

async function loadPollRows(pollBars: number): Promise<MesRow[]> {
  const safePollBars = Math.max(2, Math.min(120, Math.trunc(pollBars)))
  const oneMinuteLookback = Math.max(
    POLL_MIN_1M_LOOKBACK,
    safePollBars * 15 + 90
  )
  const latest1m = await readLatestMes1mRows(oneMinuteLookback)
  const rows = aggregateTo15mFrom1m(latest1m).slice(-safePollBars)

  return [...rows]
    .sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())
    .filter((r) => !isWeekendBar(r.eventTime))
}

function sourceAgeSeconds(latest: Date | null): number | null {
  if (!latest) return null
  return Math.max(0, Math.floor((Date.now() - latest.getTime()) / 1000))
}

function getMes1mOwnerMode(): Mes1mOwnerMode {
  const raw = (process.env.MES_1M_OWNER || process.env.MES_HIGHER_TF_OWNER || 'inngest')
    .trim()
    .toLowerCase()
  return raw === 'worker' ? 'worker' : 'inngest'
}

function isMesMarketOpen(date: Date): boolean {
  const day = date.getUTCDay()
  const hour = date.getUTCHours()
  if (day === 6) return false
  if (day === 0) return hour >= 22
  if (day === 5) return hour < 22
  return true
}

function buildOwnerPathMeta(snapshot: Mes1mFreshnessSnapshot | null): LiveMesOwnerPathMeta {
  const marketOpen = isMesMarketOpen(new Date())
  const latest = snapshot?.latestEventTime ?? null
  const latestAge = sourceAgeSeconds(latest)
  const telemetryAvailable = snapshot !== null
  let lagState: OwnerLagState = 'unknown'

  if (telemetryAvailable) {
    if (!marketOpen) {
      lagState = 'market-closed'
    } else if (latestAge == null || (snapshot.rowsLast15m ?? 0) === 0) {
      lagState = 'no-recent-rows'
    } else if (latestAge > MES_1M_OWNER_PATH.lagAlertSeconds) {
      lagState = 'lagging'
    } else {
      lagState = 'on-time'
    }
  }

  return {
    writerFunctionId: MES_1M_OWNER_PATH.writerFunctionId,
    writerFunctionFile: MES_1M_OWNER_PATH.writerFunctionFile,
    writerPath: `${MES_1M_OWNER_PATH.writerFunctionFile}#${MES_1M_OWNER_PATH.writerFunctionId}`,
    ownerMode: getMes1mOwnerMode(),
    upstreamProvider: MES_1M_OWNER_PATH.upstreamProvider,
    sourceTable: MES_1M_OWNER_PATH.sourceTable,
    expectedCadenceSeconds: MES_1M_OWNER_PATH.expectedCadenceSeconds,
    lagAlertSeconds: MES_1M_OWNER_PATH.lagAlertSeconds,
    marketOpen,
    latest1mRowTime: latest ? latest.toISOString() : null,
    latest1mRowAgeSeconds: latestAge,
    rowsLast5m: snapshot?.rowsLast5m ?? null,
    rowsLast15m: snapshot?.rowsLast15m ?? null,
    rowsLast60m: snapshot?.rowsLast60m ?? null,
    freshnessLagSeconds:
      latestAge == null ? null : Math.max(0, latestAge - MES_1M_OWNER_PATH.expectedCadenceSeconds),
    lagState,
    telemetryAvailable,
  }
}

function staleAttribution(ownerPath: LiveMesOwnerPathMeta): FreshnessAttribution {
  if (!ownerPath.telemetryAvailable) return 'owner-path-telemetry-unavailable'
  if (!ownerPath.marketOpen) return 'market-closed'
  if (ownerPath.lagState === 'no-recent-rows') return 'no-recent-1m-rows'
  return 'owner-path-freshness-lag'
}

function freshAttribution(ownerPath: LiveMesOwnerPathMeta): FreshnessAttribution {
  if (!ownerPath.telemetryAvailable) return 'owner-path-telemetry-unavailable'
  if (!ownerPath.marketOpen) return 'market-closed'
  return 'owner-path-healthy'
}

function emptySourceAttribution(ownerPath: LiveMesOwnerPathMeta): FreshnessAttribution {
  if (!ownerPath.telemetryAvailable) return 'owner-path-telemetry-unavailable'
  if (!ownerPath.marketOpen) return 'market-closed'
  if (ownerPath.lagState === 'no-recent-rows') return 'no-recent-1m-rows'
  return 'owner-path-freshness-lag'
}

function freshMeta(
  rows: MesRow[],
  mode: RouteMode,
  requestedBars: number,
  ownerPath: LiveMesOwnerPathMeta,
): LiveMesMeta {
  const latest = rows[rows.length - 1]?.eventTime ?? null
  const age = sourceAgeSeconds(latest)
  const isStale = age !== null ? age > STALE_AFTER_SECONDS : null
  const stale = isStale === true

  return {
    status: stale ? 'stale' : 'fresh',
    attribution: stale ? staleAttribution(ownerPath) : freshAttribution(ownerPath),
    mode,
    source: SOURCE_TABLE,
    requestedBars,
    sourceBarCount: rows.length,
    latestBarTime: latest ? latest.toISOString() : null,
    sourceAgeSeconds: age,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    isStale,
    ownerPath,
    updatedAt: new Date().toISOString(),
  }
}

function emptySourceMeta(
  mode: RouteMode,
  requestedBars: number,
  ownerPath: LiveMesOwnerPathMeta,
): LiveMesMeta {
  return {
    status: 'empty-source',
    attribution: emptySourceAttribution(ownerPath),
    mode,
    source: SOURCE_TABLE,
    requestedBars,
    sourceBarCount: 0,
    latestBarTime: null,
    sourceAgeSeconds: null,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    isStale: null,
    ownerPath,
    updatedAt: new Date().toISOString(),
  }
}

function runtimeFailureMeta(
  mode: RouteMode,
  requestedBars: number,
  ownerPath: LiveMesOwnerPathMeta,
): LiveMesMeta {
  return {
    status: 'runtime-failure',
    attribution: 'reader-path-runtime-failure',
    mode,
    source: SOURCE_TABLE,
    requestedBars,
    sourceBarCount: 0,
    latestBarTime: null,
    sourceAgeSeconds: null,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    isStale: null,
    ownerPath,
    updatedAt: new Date().toISOString(),
  }
}

async function loadOwnerPathMeta(): Promise<LiveMesOwnerPathMeta> {
  try {
    const snapshot = await readMes1mFreshnessSnapshot()
    return buildOwnerPathMeta(snapshot)
  } catch {
    return buildOwnerPathMeta(null)
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const ownerPathMeta = await loadOwnerPathMeta()
  const backfill = Number(url.searchParams.get('backfill') || '96')
  const pollOnly = url.searchParams.get('poll') === '1'
  const pollBarsRaw = Number(url.searchParams.get('bars') || '12')
  const pollBars = Number.isFinite(pollBarsRaw)
    ? Math.max(2, Math.min(120, Math.trunc(pollBarsRaw)))
    : 12
  const pollFingerprintRaw = (url.searchParams.get('fingerprint') || '').trim()
  const pollFingerprint = pollFingerprintRaw.length > 0 ? pollFingerprintRaw : null
  const backfillCount = Number.isFinite(backfill)
    ? Math.max(20, Math.min(1000, Math.trunc(backfill)))
    : 96

  if (pollOnly) {
    try {
      const pollRows = await loadPollRows(pollBars)

      if (pollRows.length === 0) {
        return Response.json(
          {
            error:
              'No MES 15m data in DB yet. Start ingestion: npm run ingest:mes:live:stream',
            meta: emptySourceMeta('poll', pollBars, ownerPathMeta),
          },
          { status: 503, headers: JSON_HEADERS }
        )
      }

      const fingerprint = pollRowsFingerprint(pollRows)
      const changed = pollFingerprint == null || pollFingerprint !== fingerprint

      return Response.json({
        points: changed ? pollRows.map(asPoint) : [],
        live: true,
        changed,
        fingerprint,
        meta: freshMeta(pollRows, 'poll', pollBars, ownerPathMeta),
      }, { headers: JSON_HEADERS })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json(
        {
          error: `Failed to load MES 15m poll snapshot: ${message}`,
          meta: runtimeFailureMeta('poll', pollBars, ownerPathMeta),
        },
        { status: 500, headers: JSON_HEADERS }
      )
    }
  }

  try {
    const initial = await loadSnapshotRows(backfillCount)

    if (initial.length === 0) {
      return Response.json(
        {
            error:
              'No MES 15m data in DB yet. Start ingestion: npm run ingest:mes:live:stream',
          meta: emptySourceMeta('snapshot', backfillCount, ownerPathMeta),
        },
        { status: 503, headers: JSON_HEADERS }
      )
    }

    return Response.json({
      points: initial.map(asPoint),
      live: false,
      meta: freshMeta(initial, 'snapshot', backfillCount, ownerPathMeta),
    }, { headers: JSON_HEADERS })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json(
      {
        error: `Failed to load MES 15m snapshot: ${message}`,
        meta: runtimeFailureMeta('snapshot', backfillCount, ownerPathMeta),
      },
      { status: 500, headers: JSON_HEADERS }
    )
  }
}
