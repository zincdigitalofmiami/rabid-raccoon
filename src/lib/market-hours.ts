/** CME Micro E-mini: Sun 17:00 CT – Fri 16:00 CT (daily break 16:00-16:59) */
export function isFuturesMarketOpen(): boolean {
  const ct = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const day = ct.getDay(); // 0=Sun
  const h = ct.getHours();
  if (day === 6) return false;
  if (day === 0) return h >= 17;
  if (day === 5) return h < 16;
  return h !== 16;
}

/** Returns a longer interval when market is closed to reduce needless polling */
export function marketAwarePollInterval(liveMs: number, closedMs = 300_000): number {
  return isFuturesMarketOpen() ? liveMs : closedMs;
}
