import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const limit = Math.min(Number(url.searchParams.get('limit') || '50'), 200)

    const setups = await prisma.bhgSetup.findMany({
      where: { phase: { in: ['GO_FIRED', 'EXPIRED'] } },
      orderBy: { goTime: 'desc' },
      take: limit,
    })

    // Convert BigInt IDs to strings for JSON serialization
    const serialized = setups.map((s) => ({
      ...s,
      id: String(s.id),
    }))

    return NextResponse.json({ setups: serialized })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message, setups: [] }, { status: 500 })
  }
}
