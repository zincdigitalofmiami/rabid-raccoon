import { Decimal } from '@prisma/client/runtime/client'

export function toNum(val: Decimal | number | null | undefined): number {
  if (val === null || val === undefined) return 0
  if (typeof val === 'number') return val
  return val.toNumber()
}

export function toOhlcv(row: {
  open: Decimal | number
  high: Decimal | number
  low: Decimal | number
  close: Decimal | number
  volume?: bigint | number | null
}) {
  return {
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume ? Number(row.volume) : 0,
  }
}
