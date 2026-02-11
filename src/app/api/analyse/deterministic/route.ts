import { NextResponse } from 'next/server'
import { loadAnalysisInputs } from '@/lib/analyse-data'
import { runDeterministicAnalysis } from '@/lib/instant-analysis'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST() {
  try {
    const { allData, symbolNames, marketContext } = await loadAnalysisInputs()
    const analysis = runDeterministicAnalysis(allData, symbolNames, marketContext)
    return NextResponse.json(analysis)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    const isNoData = msg.includes('No market data available')
    return NextResponse.json(
      { error: `Deterministic analysis failed: ${msg}` },
      { status: isNoData ? 503 : 500 }
    )
  }
}
