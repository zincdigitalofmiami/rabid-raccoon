import fs from 'node:fs'
import path from 'node:path'
import { Timeframe } from '@prisma/client'
import { CandleData } from '../src/lib/types'

export type CliTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w'

const TF_MINUTES: Record<CliTimeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
}

export function loadDotEnvFiles(): void {
  const files = ['.env.local', '.env']
  for (const rel of files) {
    const envPath = path.resolve(process.cwd(), rel)
    if (!fs.existsSync(envPath)) continue

    const lines = fs.readFileSync(envPath, 'utf8').split('\n')
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue

      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
      if (!process.env[key]) process.env[key] = value
    }
  }
}

export function parseArg(name: string, fallback: string): string {
  const prefixed = `--${name}=`
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefixed)) return arg.slice(prefixed.length)
  }

  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

export function parseTimeframe(raw: string): CliTimeframe {
  const tf = raw.trim().toLowerCase() as CliTimeframe
  if (!Object.keys(TF_MINUTES).includes(tf)) {
    throw new Error(`Unsupported timeframe '${raw}'. Allowed: ${Object.keys(TF_MINUTES).join(', ')}`)
  }
  return tf
}

export function timeframeToPrisma(tf: CliTimeframe): Timeframe {
  const map: Record<CliTimeframe, Timeframe> = {
    '1m': Timeframe.M1,
    '5m': Timeframe.M5,
    '15m': Timeframe.M15,
    '1h': Timeframe.H1,
    '4h': Timeframe.H4,
    '1d': Timeframe.D1,
    '1w': Timeframe.W1,
  }
  return map[tf]
}

export function timeframeToMinutes(tf: CliTimeframe): number {
  return TF_MINUTES[tf]
}

export function aggregateCandles(candles: CandleData[], periodMinutes: number): CandleData[] {
  if (candles.length === 0) return []
  const periodSec = periodMinutes * 60
  const out: CandleData[] = []
  let bucket: CandleData | null = null
  let bucketStart = 0

  for (const candle of candles) {
    const aligned = Math.floor(candle.time / periodSec) * periodSec
    if (bucket === null || aligned !== bucketStart) {
      if (bucket) out.push(bucket)
      bucket = {
        time: aligned,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      }
      bucketStart = aligned
    } else {
      bucket.high = Math.max(bucket.high, candle.high)
      bucket.low = Math.min(bucket.low, candle.low)
      bucket.close = candle.close
      bucket.volume = (bucket.volume || 0) + (candle.volume || 0)
    }
  }

  if (bucket) out.push(bucket)
  return out
}

export function splitIntoDayChunks(start: Date, end: Date, chunkDays: number): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = []
  let cursor = new Date(start)
  while (cursor < end) {
    const chunkEnd = new Date(cursor.getTime() + chunkDays * 24 * 60 * 60 * 1000)
    chunks.push({
      start: new Date(cursor),
      end: chunkEnd < end ? chunkEnd : new Date(end),
    })
    cursor = chunkEnd
  }
  return chunks
}

export function formatUtcIso(date: Date): string {
  return date.toISOString()
}

export function asUtcDateFromUnixSeconds(seconds: number): Date {
  return new Date(seconds * 1000)
}

/** Neutralize spreadsheet formula injection in untrusted text before CSV export. */
export function neutralizeFormula(value: string): string {
  const trimmed = value.trimStart()
  if (/^[=+\-@]/.test(trimmed)) return "'" + value
  return value
}

/** Constrain an output path to stay within the project root. Uses path.relative() to prevent sibling-prefix bypass. */
export function safeOutputPath(raw: string, projectRoot: string): string {
  const resolved = path.resolve(raw)
  const rel = path.relative(projectRoot, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Output path "${resolved}" is outside project root "${projectRoot}"`)
  }
  return resolved
}
