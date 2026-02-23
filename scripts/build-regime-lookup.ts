/**
 * build-regime-lookup.ts — Build bucketed p(TP1)/p(TP2) lookup table
 *
 * Reads bhg_setups.csv (with outcome labels) and computes empirical
 * hit rates bucketed by key features. Outputs regime-lookup.json
 * consumed by ml-baseline.ts for live inference.
 *
 * Buckets by:
 *   - fibRatio: 0.5 | 0.618
 *   - riskGrade: A | B | C | D
 *   - vixBucket: low (<16) | mid (16-25) | high (>25)
 *   - sessionBucket: from bhg_setups.csv session_bucket field
 *   - goType: BREAK | CLOSE
 *
 * Run: npx tsx scripts/build-regime-lookup.ts
 */

import * as fs from 'fs'
import * as path from 'path'

interface BhgRow {
  fib_ratio: number
  grade: string
  vix_level: number | null
  session_bucket: string
  go_type: string
  rr: number
  tp1_before_sl_1h: number // 1 or 0
  tp1_before_sl_4h: number
  tp2_before_sl_8h: number
}

interface BucketStats {
  key: string
  fibRatio: string
  riskGrade: string
  vixBucket: string
  sessionBucket: string
  goType: string
  count: number
  pTp1_1h: number
  pTp1_4h: number
  pTp2_8h: number
}

function parseCSV(filepath: string): BhgRow[] {
  const raw = fs.readFileSync(filepath, 'utf-8')
  const lines = raw.trim().split('\n')
  const headers = lines[0].split(',')

  const idx = (name: string) => {
    const i = headers.indexOf(name)
    if (i < 0) throw new Error(`Column "${name}" not found. Available: ${headers.join(', ')}`)
    return i
  }

  const rows: BhgRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',')
    const vix = cols[idx('vix_level')]
    rows.push({
      fib_ratio: parseFloat(cols[idx('fib_ratio')]),
      grade: cols[idx('grade')],
      vix_level: vix && vix !== '' ? parseFloat(vix) : null,
      session_bucket: cols[idx('session_bucket')],
      go_type: cols[idx('go_type')],
      rr: parseFloat(cols[idx('rr')]),
      tp1_before_sl_1h: parseInt(cols[idx('tp1_before_sl_1h')], 10),
      tp1_before_sl_4h: parseInt(cols[idx('tp1_before_sl_4h')], 10),
      tp2_before_sl_8h: parseInt(cols[idx('tp2_before_sl_8h')], 10),
    })
  }

  return rows.filter(r => !isNaN(r.tp1_before_sl_1h))
}

function vixBucket(vix: number | null): string {
  if (vix == null) return 'unknown'
  if (vix < 16) return 'low'
  if (vix <= 25) return 'mid'
  return 'high'
}

function fibBucket(ratio: number): string {
  return ratio <= 0.55 ? '0.5' : '0.618'
}

function buildKey(fibR: string, grade: string, vix: string, session: string, goType: string): string {
  return `${fibR}|${grade}|${vix}|${session}|${goType}`
}

function main() {
  const csvPath = path.resolve(__dirname, '../datasets/autogluon/bhg_setups.csv')
  if (!fs.existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`)
    process.exit(1)
  }

  console.log(`Reading ${csvPath}...`)
  const rows = parseCSV(csvPath)
  console.log(`Loaded ${rows.length} setups with outcomes`)

  // Accumulate per bucket
  const buckets = new Map<string, {
    fibRatio: string; riskGrade: string; vixBucket: string;
    sessionBucket: string; goType: string;
    tp1_1h: number[]; tp1_4h: number[]; tp2_8h: number[];
  }>()

  for (const row of rows) {
    const fR = fibBucket(row.fib_ratio)
    const vB = vixBucket(row.vix_level)
    const key = buildKey(fR, row.grade, vB, row.session_bucket, row.go_type)

    if (!buckets.has(key)) {
      buckets.set(key, {
        fibRatio: fR, riskGrade: row.grade, vixBucket: vB,
        sessionBucket: row.session_bucket, goType: row.go_type,
        tp1_1h: [], tp1_4h: [], tp2_8h: [],
      })
    }

    const b = buckets.get(key)!
    b.tp1_1h.push(row.tp1_before_sl_1h)
    b.tp1_4h.push(row.tp1_before_sl_4h)
    b.tp2_8h.push(row.tp2_before_sl_8h)
  }

  // Compute stats
  const stats: BucketStats[] = []
  const MIN_SAMPLES = 5

  for (const [key, b] of buckets) {
    if (b.tp1_4h.length < MIN_SAMPLES) continue

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length

    stats.push({
      key,
      fibRatio: b.fibRatio,
      riskGrade: b.riskGrade,
      vixBucket: b.vixBucket,
      sessionBucket: b.sessionBucket,
      goType: b.goType,
      count: b.tp1_4h.length,
      pTp1_1h: Math.round(avg(b.tp1_1h) * 10000) / 10000,
      pTp1_4h: Math.round(avg(b.tp1_4h) * 10000) / 10000,
      pTp2_8h: Math.round(avg(b.tp2_8h) * 10000) / 10000,
    })
  }

  // Also compute fallback (global averages by individual features)
  const globalAvg = {
    pTp1_1h: rows.reduce((s, r) => s + r.tp1_before_sl_1h, 0) / rows.length,
    pTp1_4h: rows.reduce((s, r) => s + r.tp1_before_sl_4h, 0) / rows.length,
    pTp2_8h: rows.reduce((s, r) => s + r.tp2_before_sl_8h, 0) / rows.length,
    count: rows.length,
  }

  // Per-grade fallback
  const gradeMap = new Map<string, { tp1_4h: number[]; tp2_8h: number[] }>()
  for (const row of rows) {
    if (!gradeMap.has(row.grade)) gradeMap.set(row.grade, { tp1_4h: [], tp2_8h: [] })
    gradeMap.get(row.grade)!.tp1_4h.push(row.tp1_before_sl_4h)
    gradeMap.get(row.grade)!.tp2_8h.push(row.tp2_before_sl_8h)
  }
  const gradeFallback: Record<string, { pTp1: number; pTp2: number; count: number }> = {}
  for (const [grade, data] of gradeMap) {
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length
    gradeFallback[grade] = {
      pTp1: Math.round(avg(data.tp1_4h) * 10000) / 10000,
      pTp2: Math.round(avg(data.tp2_8h) * 10000) / 10000,
      count: data.tp1_4h.length,
    }
  }

  const lookup = {
    generatedAt: new Date().toISOString(),
    totalSetups: rows.length,
    bucketsWithMinSamples: stats.length,
    minSamples: MIN_SAMPLES,
    global: {
      pTp1: Math.round(globalAvg.pTp1_4h * 10000) / 10000,
      pTp2: Math.round(globalAvg.pTp2_8h * 10000) / 10000,
      count: globalAvg.count,
    },
    gradeFallback,
    buckets: stats.sort((a, b) => b.count - a.count),
  }

  // Write to src/data/
  const outDir = path.resolve(__dirname, '../src/data')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'regime-lookup.json')
  fs.writeFileSync(outPath, JSON.stringify(lookup, null, 2))

  console.log(`\n=== Regime Lookup Built ===`)
  console.log(`Total setups:  ${rows.length}`)
  console.log(`Buckets (≥${MIN_SAMPLES} samples): ${stats.length}`)
  console.log(`Global p(TP1): ${(globalAvg.pTp1_4h * 100).toFixed(1)}%`)
  console.log(`Global p(TP2): ${(globalAvg.pTp2_8h * 100).toFixed(1)}%`)
  console.log(`\nPer-grade:`)
  for (const [grade, data] of Object.entries(gradeFallback)) {
    console.log(`  ${grade}: p(TP1)=${(data.pTp1 * 100).toFixed(1)}%  p(TP2)=${(data.pTp2 * 100).toFixed(1)}%  (n=${data.count})`)
  }
  console.log(`\nWritten to: ${outPath}`)
}

main()
