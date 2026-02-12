/**
 * Lightweight Charts Series Primitive: Forecast Target Zones
 *
 * Renders Entry/TP/SL as horizontal shaded bands (when bandHalfWidth > 0)
 * or dashed lines (when bandHalfWidth === 0) extending into the future.
 * Price axis labels show colored tags per target kind.
 *
 * Uses fancy-canvas useMediaCoordinateSpace for drawing.
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
  Logical,
  Coordinate,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { ForecastTarget } from './types'

// --- Renderer: draws zones + labels on the main pane ---

class ForecastTargetsRenderer implements IPrimitivePaneRenderer {
  private _targets: ForecastTarget[] = []
  private _priceToY: ((price: number) => Coordinate | null) | null = null
  private _timeToX: ((time: Time) => Coordinate | null) | null = null

  update(
    targets: ForecastTarget[],
    priceToY: (price: number) => Coordinate | null,
    timeToX: (time: Time) => Coordinate | null
  ) {
    this._targets = targets
    this._priceToY = priceToY
    this._timeToX = timeToX
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this._priceToY || !this._timeToX) return

      for (const t of this._targets) {
        const startX = this._timeToX(t.startTime as unknown as Time)
        const endX = this._timeToX(t.endTime as unknown as Time)
        const centerY = this._priceToY(t.price)

        if (centerY == null) continue

        // Clamp X to chart bounds
        const x0 = startX != null ? Math.max(0, startX) : 0
        const x1 = endX != null ? Math.min(mediaSize.width, endX) : mediaSize.width

        if (x1 <= x0) continue

        if (t.bandHalfWidth > 0) {
          // Shaded band
          const topY = this._priceToY(t.price + t.bandHalfWidth)
          const botY = this._priceToY(t.price - t.bandHalfWidth)
          if (topY == null || botY == null) continue

          const y0 = Math.min(topY, botY)
          const h = Math.abs(botY - topY)

          ctx.fillStyle = hexToRgba(t.color, 0.15)
          ctx.fillRect(x0, y0, x1 - x0, h)

          // Border lines
          ctx.strokeStyle = hexToRgba(t.color, 0.5)
          ctx.lineWidth = 1
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y0)
          ctx.moveTo(x0, y0 + h)
          ctx.lineTo(x1, y0 + h)
          ctx.stroke()

          // Center dashed line
          ctx.strokeStyle = hexToRgba(t.color, 0.7)
          ctx.setLineDash([4, 4])
          ctx.beginPath()
          ctx.moveTo(x0, centerY)
          ctx.lineTo(x1, centerY)
          ctx.stroke()
          ctx.setLineDash([])
        } else {
          // Dashed horizontal line only
          ctx.strokeStyle = hexToRgba(t.color, 0.7)
          ctx.lineWidth = 1
          ctx.setLineDash([6, 3])
          ctx.beginPath()
          ctx.moveTo(x0, centerY)
          ctx.lineTo(x1, centerY)
          ctx.stroke()
          ctx.setLineDash([])
        }

        // In-zone text label
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
        ctx.fillStyle = hexToRgba(t.color, 0.9)
        ctx.textBaseline = 'bottom'
        ctx.fillText(t.label, x0 + 6, centerY - 3)
      }
    })
  }
}

// --- Pane View: bridges renderer to LC ---

class ForecastTargetsPaneView implements IPrimitivePaneView {
  private _renderer = new ForecastTargetsRenderer()

  update(
    targets: ForecastTarget[],
    priceToY: (price: number) => Coordinate | null,
    timeToX: (time: Time) => Coordinate | null
  ) {
    this._renderer.update(targets, priceToY, timeToX)
  }

  zOrder(): 'bottom' {
    return 'bottom'
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer
  }
}

// --- Price Axis View: colored labels on the price axis ---

class ForecastTargetAxisView implements ISeriesPrimitiveAxisView {
  private _target: ForecastTarget
  private _coord: number

  constructor(target: ForecastTarget, coord: number) {
    this._target = target
    this._coord = coord
  }

  coordinate(): number {
    return this._coord
  }

  text(): string {
    return `${this._target.kind} ${this._target.price.toFixed(2)}`
  }

  textColor(): string {
    return '#ffffff'
  }

  backColor(): string {
    return this._target.color
  }

  visible(): boolean {
    return true
  }

  tickVisible(): boolean {
    return true
  }
}

// --- Main Primitive ---

export class ForecastTargetsPrimitive implements ISeriesPrimitive<Time> {
  private _targets: ForecastTarget[] = []
  private _paneView = new ForecastTargetsPaneView()
  private _axisViews: ForecastTargetAxisView[] = []
  private _attachedParams: SeriesAttachedParameter<Time, SeriesType> | null = null

  setTargets(targets: ForecastTarget[]) {
    this._targets = targets
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

    this._paneView.update(this._targets, priceToY, timeToX)

    // Rebuild axis views
    this._axisViews = []
    for (const t of this._targets) {
      const coord = series.priceToCoordinate(t.price)
      if (coord != null) {
        this._axisViews.push(new ForecastTargetAxisView(t, coord))
      }
    }
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView]
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this._axisViews
  }

  autoscaleInfo(): AutoscaleInfo | null {
    if (this._targets.length === 0) return null

    let min = Infinity
    let max = -Infinity

    for (const t of this._targets) {
      const lo = t.price - t.bandHalfWidth
      const hi = t.price + t.bandHalfWidth
      if (lo < min) min = lo
      if (hi > max) max = hi
    }

    if (min === Infinity) return null

    return {
      priceRange: {
        minValue: min,
        maxValue: max,
      },
    }
  }
}

// --- Utility ---

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
