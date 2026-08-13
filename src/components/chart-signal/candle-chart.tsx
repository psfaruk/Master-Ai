"use client"

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import type { Candle } from "@/lib/candle-fetcher"

interface CandleChartProps {
  candles: Candle[]
  /** Mark this candle's signal direction (CALL/PUT) with an arrow on the bar. */
  signalCandleTime?: number
  signalDirection?: "CALL" | "PUT" | null
  /** Limit on number of candles to draw (default 30). */
  maxBars?: number
  className?: string
  /** Height of the chart in pixels. */
  height?: number
}

/**
 * CandleChart
 * -----------
 * A self-contained SVG candlestick chart. No external charting library —
 * we draw bars directly so the bundle stays small and the visual style
 * matches the rest of the dashboard (dark slate background, emerald/rose
 * candles).
 *
 * Each candle shows:
 *   - A vertical wick from low → high (when high/low are available)
 *   - A solid body from open → close
 *   - Color: emerald when close >= open (bullish), rose when close < open (bearish)
 *
 * When high/low are null (which happens for App 3's historical rows, where
 * we only have a_open and a_close), the body is drawn without a wick.
 *
 * A small triangle above/below the signal candle marks the signal direction:
 *   - CALL → green up-arrow below the bar
 *   - PUT  → red down-arrow above the bar
 */
export function CandleChart({
  candles,
  signalCandleTime,
  signalDirection,
  maxBars = 30,
  className,
  height = 180,
}: CandleChartProps) {
  // Take the newest N candles, then reverse so the chart reads left-to-right
  // oldest → newest (standard candlestick convention).
  const bars = useMemo(() => {
    const sorted = [...candles].sort((a, b) => a.candleTime - b.candleTime)
    return sorted.slice(-maxBars)
  }, [candles, maxBars])

  if (bars.length === 0) {
    return (
      <div
        className={cn(
          "rounded-md border border-slate-800 bg-slate-950/40 flex items-center justify-center text-[11px] text-slate-500",
          className
        )}
        style={{ height }}
      >
        No candle data yet — refresh in a moment.
      </div>
    )
  }

  const width = 100 // SVG viewBox width — we scale via CSS
  const padding = 4
  const chartH = height - padding * 2
  const barGap = 0.5
  const barW = (width - padding * 2) / bars.length - barGap
  const bodyW = Math.max(1.5, barW * 0.7)

  // Price range — include all highs/lows (or open/close if no high/low).
  const allPrices: number[] = []
  for (const b of bars) {
    allPrices.push(b.open, b.close)
    if (b.high != null) allPrices.push(b.high)
    if (b.low != null) allPrices.push(b.low)
  }
  const minP = Math.min(...allPrices)
  const maxP = Math.max(...allPrices)
  // Add 5% padding to top/bottom so the bars don't touch the edges.
  const range = maxP - minP || 1
  const pad = range * 0.05
  const yMin = minP - pad
  const yMax = maxP + pad
  const yScale = (p: number) => padding + ((yMax - p) / (yMax - yMin)) * chartH

  return (
    <div
      className={cn("rounded-md border border-slate-800 bg-slate-950/40", className)}
      style={{ height }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-full"
      >
        {/* Horizontal grid lines — 4 evenly spaced price levels */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padding + f * chartH
          const p = yMax - f * (yMax - yMin)
          return (
            <g key={f}>
              <line
                x1={padding}
                x2={width - padding}
                y1={y}
                y2={y}
                stroke="#1e293b"
                strokeWidth={0.2}
                strokeDasharray="0.5 0.5"
              />
              <text
                x={width - padding + 0.5}
                y={y + 1}
                fontSize={2}
                fill="#64748b"
                fontFamily="monospace"
              >
                {formatPrice(p)}
              </text>
            </g>
          )
        })}

        {/* Candles */}
        {bars.map((b, i) => {
          const x = padding + i * (barW + barGap) + barW / 2
          const yOpen = yScale(b.open)
          const yClose = yScale(b.close)
          const bullish = b.close >= b.open
          const color = bullish ? "#34d399" : "#fb7185"

          const bodyTop = Math.min(yOpen, yClose)
          const bodyBottom = Math.max(yOpen, yClose)
          const bodyHeight = Math.max(0.5, bodyBottom - bodyTop)

          const yHigh = b.high != null ? yScale(b.high) : bodyTop
          const yLow = b.low != null ? yScale(b.low) : bodyBottom

          const isSignal = signalCandleTime === b.candleTime

          return (
            <g key={b.candleTime}>
              {/* Wick */}
              {(b.high != null || b.low != null) && (
                <line
                  x1={x}
                  x2={x}
                  y1={yHigh}
                  y2={yLow}
                  stroke={color}
                  strokeWidth={0.3}
                />
              )}
              {/* Body */}
              <rect
                x={x - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={bodyHeight}
                fill={color}
                opacity={isSignal ? 1 : 0.85}
              />
              {/* Signal marker */}
              {isSignal && signalDirection && (
                <g>
                  {signalDirection === "CALL" ? (
                    // Up arrow below the bar
                    <polygon
                      points={`${x},${bodyBottom + 1} ${x - 1},${bodyBottom + 2.5} ${x + 1},${bodyBottom + 2.5}`}
                      fill="#34d399"
                    />
                  ) : (
                    // Down arrow above the bar
                    <polygon
                      points={`${x},${bodyTop - 1} ${x - 1},${bodyTop - 2.5} ${x + 1},${bodyTop - 2.5}`}
                      fill="#fb7185"
                    />
                  )}
                </g>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toFixed(0)
  if (p >= 1) return p.toFixed(3)
  return p.toFixed(5)
}
