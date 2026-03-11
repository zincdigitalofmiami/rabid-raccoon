import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST() {
  return NextResponse.json(
    {
      error: 'Deterministic analysis endpoint has been removed.',
    },
    { status: 410 },
  )
}
