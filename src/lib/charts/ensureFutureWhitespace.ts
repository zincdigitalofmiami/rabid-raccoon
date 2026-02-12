import { UTCTimestamp } from 'lightweight-charts'

/**
 * Generate whitespace data points extending past the last candle.
 * These allow LC to show the time axis into the future so that
 * forecast target zones can render beyond the last real bar.
 */
export function ensureFutureWhitespace(
  lastTime: number,
  barIntervalSec: number,
  count: number = 8
): { time: UTCTimestamp }[] {
  const points: { time: UTCTimestamp }[] = []
  for (let i = 1; i <= count; i++) {
    points.push({ time: (lastTime + barIntervalSec * i) as UTCTimestamp })
  }
  return points
}
