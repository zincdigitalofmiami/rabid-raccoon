/**
 * Lightweight Charts Series Primitive: Pivot Lines
 *
 * Renders traditional pivot levels (P, R1-R5, S1-S5) as solid horizontal
 * lines with text labels at the left edge. NO axis boxes. NO dotted lines.
 *
 * Follows the same ISeriesPrimitive pattern as ForecastTargetsPrimitive.
 */

import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  SeriesType,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  AutoscaleInfo,
  Coordinate,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { PivotLine, PivotTimeframe } from "@/lib/pivots";

// --- Styling constants ---

const STYLES = {
  pivotLineWidth: 2, // P (pivot point) line — thicker
  levelLineWidth: 1, // R/S lines — thinner
  labelFont: '10px -apple-system, BlinkMacSystemFont, "Inter", sans-serif',
  labelPaddingX: 6,
  labelPaddingY: 3,
  labelBgAlpha: 0.7,
  lineAlpha: 0.6,
  pivotLineAlpha: 0.8,
} as const;

// --- Internal pivot item with resolved color ---

interface ResolvedPivot {
  price: number;
  label: string;
  level: string;
  startTime?: number;
  color: string;
  isPivotPoint: boolean;
}

// --- Renderer: draws pivot lines + labels on the main pane ---

class PivotLinesRenderer implements IPrimitivePaneRenderer {
  private _pivots: ResolvedPivot[] = [];
  private _priceToY: ((price: number) => Coordinate | null) | null = null;
  private _timeToX: ((time: Time) => Coordinate | null) | null = null;

  update(
    pivots: ResolvedPivot[],
    priceToY: (price: number) => Coordinate | null,
    timeToX: (time: Time) => Coordinate | null
  ) {
    this._pivots = pivots;
    this._priceToY = priceToY;
    this._timeToX = timeToX;
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (!this._priceToY || !this._timeToX) return;

      for (const p of this._pivots) {
        const y = this._priceToY(p.price);
        if (y == null) continue;

        // Skip lines outside the visible vertical range (with padding)
        if (y < -20 || y > mediaSize.height + 20) continue;

        const alpha = p.isPivotPoint ? STYLES.pivotLineAlpha : STYLES.lineAlpha;
        const lineWidth = p.isPivotPoint
          ? STYLES.pivotLineWidth
          : STYLES.levelLineWidth;

        const startXRaw =
          p.startTime != null
            ? this._timeToX(p.startTime as unknown as Time)
            : 0;
        const x0 = startXRaw == null ? 0 : Math.max(0, startXRaw);
        if (x0 >= mediaSize.width) continue;

        // --- Draw solid horizontal segment (timeframe start → right edge) ---
        ctx.strokeStyle = hexToRgba(p.color, alpha);
        ctx.lineWidth = lineWidth;
        ctx.setLineDash([]); // SOLID — no dashing ever
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(mediaSize.width, y);
        ctx.stroke();

        // --- Draw text label near segment start ---
        ctx.font = STYLES.labelFont;
        ctx.fillStyle = hexToRgba(p.color, 0.9);
        ctx.textBaseline = "bottom";
        const labelY = y - STYLES.labelPaddingY + 1;
        if (x0 > 56) {
          // Match TradingView pivot style: label just to the left of segment
          ctx.textAlign = "right";
          ctx.fillText(p.label, x0 - 6, labelY);
        } else {
          // Fallback when segment starts near far-left boundary
          ctx.textAlign = "left";
          ctx.fillText(p.label, x0 + STYLES.labelPaddingX, labelY);
        }
        ctx.textAlign = "left";
      }
    });
  }
}

// --- Pane View: bridges renderer to LC ---

class PivotLinesPaneView implements IPrimitivePaneView {
  private _renderer = new PivotLinesRenderer();

  update(
    pivots: ResolvedPivot[],
    priceToY: (price: number) => Coordinate | null,
    timeToX: (time: Time) => Coordinate | null
  ) {
    this._renderer.update(pivots, priceToY, timeToX);
  }

  zOrder(): "top" {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

// --- Main Primitive ---

export class PivotLinesPrimitive implements ISeriesPrimitive<Time> {
  private _pivots: PivotLine[] = [];
  private _colors: Record<PivotTimeframe, string> = {
    D: "#FFFFFF",
    W: "#FF9800",
    M: "#FF9800",
    Y: "#FF9800",
  };
  private _paneView = new PivotLinesPaneView();
  private _attachedParams: SeriesAttachedParameter<Time, SeriesType> | null =
    null;

  setPivots(
    pivots: PivotLine[],
    colors?: Record<PivotTimeframe, string>
  ) {
    this._pivots = pivots;
    if (colors) this._colors = colors;
    if (this._attachedParams) {
      this._attachedParams.requestUpdate();
    }
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._attachedParams = param;
  }

  detached() {
    this._attachedParams = null;
  }

  updateAllViews() {
    if (!this._attachedParams) return;

    const { series, chart } = this._attachedParams;
    const priceToY = (price: number) => series.priceToCoordinate(price);
    const timeScale = chart.timeScale();
    const timeToX = (time: Time) => timeScale.timeToCoordinate(time);

    // Resolve colors and build internal representation
    const resolved: ResolvedPivot[] = this._pivots.map((p) => ({
      price: p.price,
      label: p.label,
      level: p.level,
      startTime: p.startTime,
      color: this._colors[p.timeframe] ?? "#FF9800",
      isPivotPoint: p.level === "P",
    }));

    this._paneView.update(resolved, priceToY, timeToX);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  // NO priceAxisViews — no colored boxes on the price axis
  priceAxisViews(): readonly [] {
    return [];
  }

  autoscaleInfo(): AutoscaleInfo | null {
    // Pivot lines don't affect autoscale — they follow the candle data range
    return null;
  }
}

// --- Utility ---

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
