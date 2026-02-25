/**
 * Lightweight Charts Series Primitive: BHG Setup Markers
 *
 * Renders Touch/Hook/Go markers and Entry/SL/TP level lines on the chart.
 * - TOUCH: small circle at fib level
 * - HOOK: triangle showing rejection direction
 * - GO: filled diamond at confirmation bar
 * - Active GO: Entry/SL/TP1/TP2 dashed lines extending into the future
 *
 * Follows the ForecastTargetsPrimitive pattern exactly.
 */

import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  SeriesType,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  ISeriesPrimitiveAxisView,
  AutoscaleInfo,
  Coordinate,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { BhgSetup } from '../bhg-engine'

// ─── Marker Data ─────────────────────────────────────────────────────────────

export interface BhgMarkerData {
  setups: BhgSetup[]
  /** Unix seconds — last candle time, used as start for level projections */
  lastTime: number
  /** How many bars into the future to project entry/SL/TP lines */
  futureBars: number
  /** Bar interval in seconds (default 900 = 15m) */
  barInterval: number
}

// ─── Colors ──────────────────────────────────────────────────────────────────

const COLORS = {
  touch: '#787b86',      // neutral grey
  hook: '#ff9800',       // amber
  go: '#22ab94',         // bull green
  entry: '#2962ff',      // blue
  sl: '#f23645',         // red
  tp1: '#26a69a',        // teal
  tp2: '#22ab94',        // bright green
  bullish: '#26a69a',
  bearish: '#ef5350',
} as const
const PRICE_BUCKET = 0.25

// ─── Renderer ────────────────────────────────────────────────────────────────

class BhgMarkersRenderer implements IPrimitivePaneRenderer {
  private _data: BhgMarkerData | null = null
  private _priceToY: ((price: number) => Coordinate | null) | null = null
  private _timeToX: ((time: Time) => Coordinate | null) | null = null

  update(
    data: BhgMarkerData | null,
    priceToY: (price: number) => Coordinate | null,
    timeToX: (time: Time) => Coordinate | null
  ) {
    this._data = data
    this._priceToY = priceToY
    this._timeToX = timeToX
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this._data || !this._priceToY || !this._timeToX) return

      const { setups, lastTime, futureBars, barInterval } = this._data
      const futureEnd = lastTime + barInterval * futureBars
      const drawnLevelKeys = new Set<string>()

      for (const setup of setups) {
        // Draw touch marker
        if (setup.touchTime != null && setup.touchPrice != null) {
          this._drawTouch(ctx, setup)
        }

        // Draw hook marker
        if (setup.hookTime != null && setup.hookClose != null) {
          this._drawHook(ctx, setup)
        }

        // Draw GO marker + level lines
        if (setup.phase === 'TRIGGERED' && setup.goTime != null && setup.entry != null) {
          this._drawGo(ctx, setup)
          this._drawLevelLines(ctx, setup, lastTime, futureEnd, mediaSize.width, drawnLevelKeys)
        }
      }
    })
  }

  private _drawTouch(ctx: CanvasRenderingContext2D, setup: BhgSetup) {
    const x = this._timeToX!(setup.touchTime! as unknown as Time)
    const y = this._priceToY!(setup.touchPrice!)
    if (x == null || y == null) return

    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fillStyle = hexToRgba(COLORS.touch, 0.6)
    ctx.fill()
    ctx.strokeStyle = hexToRgba(COLORS.touch, 0.9)
    ctx.lineWidth = 1
    ctx.stroke()
  }

  private _drawHook(ctx: CanvasRenderingContext2D, setup: BhgSetup) {
    const x = this._timeToX!(setup.hookTime! as unknown as Time)
    const hookPrice = setup.hookClose!
    const y = this._priceToY!(hookPrice)
    if (x == null || y == null) return

    const isBullish = setup.direction === 'BULLISH'
    const color = COLORS.hook
    const size = 5

    // Triangle pointing in rejection direction
    ctx.beginPath()
    if (isBullish) {
      // Upward triangle (bullish rejection bounced up)
      ctx.moveTo(x, y - size)
      ctx.lineTo(x - size, y + size)
      ctx.lineTo(x + size, y + size)
    } else {
      // Downward triangle (bearish rejection bounced down)
      ctx.moveTo(x, y + size)
      ctx.lineTo(x - size, y - size)
      ctx.lineTo(x + size, y - size)
    }
    ctx.closePath()
    ctx.fillStyle = hexToRgba(color, 0.7)
    ctx.fill()
    ctx.strokeStyle = hexToRgba(color, 1)
    ctx.lineWidth = 1
    ctx.stroke()
  }

  private _drawGo(ctx: CanvasRenderingContext2D, setup: BhgSetup) {
    const x = this._timeToX!(setup.goTime! as unknown as Time)
    const y = this._priceToY!(setup.entry!)
    if (x == null || y == null) return

    const color = setup.direction === 'BULLISH' ? COLORS.bullish : COLORS.bearish
    const size = 6

    // Filled diamond at GO bar
    ctx.beginPath()
    ctx.moveTo(x, y - size)
    ctx.lineTo(x + size, y)
    ctx.lineTo(x, y + size)
    ctx.lineTo(x - size, y)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()

    // GO label
    ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillStyle = hexToRgba(color, 0.9)
    ctx.textBaseline = 'bottom'
    ctx.textAlign = 'center'
    ctx.fillText('GO', x, y - size - 2)
    ctx.textAlign = 'start'
  }

  private _drawLevelLines(
    ctx: CanvasRenderingContext2D,
    setup: BhgSetup,
    lastTime: number,
    futureEnd: number,
    chartWidth: number,
    drawnLevelKeys: Set<string>
  ) {
    const levels: { price: number; color: string; label: string }[] = []

    if (setup.entry != null) {
      levels.push({ price: setup.entry, color: COLORS.entry, label: 'Entry' })
    }
    if (setup.stopLoss != null) {
      levels.push({ price: setup.stopLoss, color: COLORS.sl, label: 'SL' })
    }
    if (setup.tp1 != null) {
      levels.push({ price: setup.tp1, color: COLORS.tp1, label: 'TP1' })
    }
    if (setup.tp2 != null) {
      levels.push({ price: setup.tp2, color: COLORS.tp2, label: 'TP2' })
    }

    // V15 pattern: level lines render in the future whitespace only,
    // starting at lastTime — never backwards over candles.
    const startX = this._timeToX!(lastTime as unknown as Time)
    const endX = this._timeToX!(futureEnd as unknown as Time)

    for (const lvl of levels) {
      const levelKey = `${lvl.label}:${Math.round(lvl.price / PRICE_BUCKET)}`
      if (drawnLevelKeys.has(levelKey)) continue
      drawnLevelKeys.add(levelKey)

      const y = this._priceToY!(lvl.price)
      if (y == null) continue

      const x0 = startX != null ? Math.max(0, startX) : 0
      const x1 = endX != null ? Math.min(chartWidth, endX) : chartWidth

      if (x1 <= x0) continue

      // Dashed line
      ctx.strokeStyle = hexToRgba(lvl.color, 0.6)
      ctx.lineWidth = 1
      ctx.setLineDash(lvl.label === 'SL' ? [4, 3] : [6, 3])
      ctx.beginPath()
      ctx.moveTo(x0, y)
      ctx.lineTo(x1, y)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

// ─── Pane View ───────────────────────────────────────────────────────────────

class BhgMarkersPaneView implements IPrimitivePaneView {
  private _renderer = new BhgMarkersRenderer()

  update(
    data: BhgMarkerData | null,
    priceToY: (price: number) => Coordinate | null,
    timeToX: (time: Time) => Coordinate | null
  ) {
    this._renderer.update(data, priceToY, timeToX)
  }

  zOrder(): 'top' {
    return 'top'
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer
  }
}

// ─── Price Axis Views ────────────────────────────────────────────────────────

class BhgLevelAxisView implements ISeriesPrimitiveAxisView {
  private _price: number
  private _label: string
  private _color: string
  private _coord: number

  constructor(price: number, label: string, color: string, coord: number) {
    this._price = price
    this._label = label
    this._color = color
    this._coord = coord
  }

  coordinate(): number {
    return this._coord
  }

  text(): string {
    return `${this._label} ${this._price.toFixed(2)}`
  }

  textColor(): string {
    return '#ffffff'
  }

  backColor(): string {
    return this._color
  }

  visible(): boolean {
    return true
  }

  tickVisible(): boolean {
    return true
  }
}

// ─── Main Primitive ──────────────────────────────────────────────────────────

export class BhgMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _data: BhgMarkerData | null = null
  private _paneView = new BhgMarkersPaneView()
  private _axisViews: BhgLevelAxisView[] = []
  private _attachedParams: SeriesAttachedParameter<Time, SeriesType> | null = null

  setMarkers(data: BhgMarkerData | null) {
    this._data = data
    if (this._attachedParams) {
      this._attachedParams.requestUpdate()
    }
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._attachedParams = param
  }

  detached() {
    this._attachedParams = null
  }

  updateAllViews() {
    if (!this._attachedParams) return

    const { series, chart } = this._attachedParams
    const priceToY = (price: number) => series.priceToCoordinate(price)
    const timeScale = chart.timeScale()
    const timeToX = (time: Time) => timeScale.timeToCoordinate(time)

    this._paneView.update(this._data, priceToY, timeToX)

    // Build axis views for active GO setups
    this._axisViews = []
    if (this._data) {
      const deduped = new Map<
        string,
        { price: number; label: string; color: string; coord: number; ts: number }
      >()

      for (const setup of this._data.setups) {
        if (setup.phase !== 'TRIGGERED') continue
        const levels: { price: number; label: string; color: string }[] = []
        if (setup.entry != null) levels.push({ price: setup.entry, label: 'Entry', color: COLORS.entry })
        if (setup.stopLoss != null) levels.push({ price: setup.stopLoss, label: 'SL', color: COLORS.sl })
        if (setup.tp1 != null) levels.push({ price: setup.tp1, label: 'TP1', color: COLORS.tp1 })
        if (setup.tp2 != null) levels.push({ price: setup.tp2, label: 'TP2', color: COLORS.tp2 })

        for (const lvl of levels) {
          const coord = series.priceToCoordinate(lvl.price)
          if (coord != null) {
            const key = `${lvl.label}:${Math.round(lvl.price / PRICE_BUCKET)}`
            const ts = setup.goTime ?? setup.createdAt
            const prev = deduped.get(key)
            if (!prev || ts > prev.ts) {
              deduped.set(key, { price: lvl.price, label: lvl.label, color: lvl.color, coord, ts })
            }
          }
        }
      }

      this._axisViews = [...deduped.values()]
        .sort((a, b) => b.price - a.price)
        .map((v) => new BhgLevelAxisView(v.price, v.label, v.color, v.coord))
    }
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView]
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this._axisViews
  }

  autoscaleInfo(): AutoscaleInfo | null {
    // V15 pattern: don't force the chart scale to include TP/SL targets.
    // Let the candle data drive the autoscale. Target prices are shown
    // on the price-axis labels and future whitespace lines only.
    return null
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
