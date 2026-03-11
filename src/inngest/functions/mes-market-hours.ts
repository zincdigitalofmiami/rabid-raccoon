/**
 * CME Globex MES session (UTC guard):
 * - Closed Saturday
 * - Opens Sunday at 22:00 UTC
 * - Closes Friday at 22:00 UTC
 */
export function isMesMarketOpen(now: Date): boolean {
  const day = now.getUTCDay() // 0=Sun, 6=Sat
  const hour = now.getUTCHours()

  if (day === 6) return false
  if (day === 0) return hour >= 22
  if (day === 5) return hour < 22
  return true
}
