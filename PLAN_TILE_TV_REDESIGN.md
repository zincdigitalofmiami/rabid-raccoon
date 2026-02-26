# Plan: Tile Restore + Redesign + TV Widgets + Chart Fix

## Status
- [x] Step 1: Restore 5 tile files (StatusTile, CorrelationTile, SignalTile, RiskTile, MLForecastTile)
- [x] Step 2: LiveMesChart barSpacing 12, priceLineVisible:false, lastValueVisible:false
- [x] Step 3: Redesign all 5 tile components (institutional terminal aesthetic)
- [ ] Step 4: Create 5 TradingView widget components (TickerTape done, 4 remaining)
- [ ] Step 5: Wire tiles + TV widgets into TradeDashboard + MesIntradayDashboard
- [ ] Step 6: Build verify + preview

---

## Target Layout

### `/` (TradeDashboard)
TickerTape → chart → Market Pressure tiles (4-col) → Active Trades → Markets Overview

### `/mes` (MesIntradayDashboard)
chart (barSpacing 12) → MLForecastTile (full width) → 4-tile grid

---

## TV Widget Components

| File | Type | Notes |
|------|------|-------|
| `TradingViewTickerTape.tsx` | Web component `tv-ticker-tape` | ✓ Done. MES/SPX/VIX/DXY/10Y, 40px, amber border-bottom |
| `TradingViewIndicesOverview.tsx` | Script inject `embed-widget-symbol-overview.js` | SPX/NDQ/DJI area charts, 400px |
| `TradingViewHeatmap.tsx` | Script inject `embed-widget-stock-heatmap.js` | SPX500, Perf.1M, 600px |
| `TradingViewTechnicalAnalysis.tsx` | Script inject `embed-widget-technical-analysis.js` | MES1! 1h, multiple, 500px |
| `TradingViewEconomicMap.tsx` | Web component `tv-economic-map` | 500px |

---

## Chart Fixes Needed (LiveMesChart.tsx)

1. After `seriesRef.current.setData(chartData)` in `onSnapshot`, add:
   ```ts
   chartRef.current?.timeScale().applyOptions({ barSpacing: 12 })
   chartRef.current?.timeScale().scrollToPosition(16, false)
   ```
   Reason: LWC auto-fits all 672 bars on first setData, overriding barSpacing → bars become 2px wide.

2. Add `LastPriceAnimationMode.Disabled` to series creation + import it.

---

## SetupLog
- Stays deleted (user confirmed)

## NOT changing
- Any API routes, Prisma schema, hooks, globals.css, layout.tsx
