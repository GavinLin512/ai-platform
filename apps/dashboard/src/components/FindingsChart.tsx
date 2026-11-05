"use client";

import { useEffect, useRef, useState } from "react";

// New findings per day: one series, so no legend (the card title names it). Thin columns
// (≤ 24px, 4px rounded tops, square on the baseline, ≥ 2px apart), hairline gridlines, the
// peak labelled, every value on hover/focus and in the table below.

export interface DayPoint {
  day: string;
  /** Preformatted on the server ("Nov 4") so both renders agree. */
  label: string;
  findings: number;
}

const HEIGHT = 220;
const MARGIN = { top: 20, right: 8, bottom: 28, left: 36 };

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/** A column with a rounded top and a square base. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + width - r}A${r},${r} 0 0 1 ${x + width},${y + r}V${y + height}Z`;
}

export function FindingsChart({ days }: { days: DayPoint[] }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const ticks = niceTicks(Math.max(0, ...days.map((d) => d.findings)));
  const max = ticks.at(-1) ?? 1;
  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = innerWidth / Math.max(1, days.length);
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const y = (value: number) => MARGIN.top + innerHeight - (value / max) * innerHeight;
  const peak = days.reduce(
    (best, d, i) => (d.findings > (days[best]?.findings ?? -1) ? i : best),
    0,
  );
  // Date labels need ~48px each: label every 1, 2, 7 or 14 days, counted back from today so
  // the most recent day is always labelled and the spacing stays even.
  const labelEvery = [1, 2, 7, 14].find((n) => n * band >= 48) ?? 14;
  const current = active === null ? undefined : days[active];

  return (
    <div ref={wrapper} className="relative w-full">
      {/* The picture; the values are reachable through the buttons below and the table view. */}
      <svg width={width} height={HEIGHT} aria-hidden="true" className="block select-none">
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? "var(--baseline)" : "var(--gridline)"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={MARGIN.left - 6}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted text-[11px]"
            >
              {tick}
            </text>
          </g>
        ))}

        {days.map((d, i) => {
          const x = MARGIN.left + i * band + (band - barWidth) / 2;
          const top = y(d.findings);
          const showLabel = (days.length - 1 - i) % labelEvery === 0;
          return (
            <g key={d.day}>
              {d.findings > 0 ? (
                <path
                  d={columnPath(x, top, barWidth, MARGIN.top + innerHeight - top)}
                  fill="var(--series-1)"
                  opacity={active === null || active === i ? 1 : 0.55}
                />
              ) : null}
              {i === peak && d.findings > 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={top - 6}
                  textAnchor="middle"
                  className="fill-secondary text-[11px] font-medium"
                >
                  {d.findings}
                </text>
              ) : null}
              {showLabel ? (
                // A centred label near the right edge would be clipped: align it to the edge.
                <text
                  x={x + barWidth / 2 + 20 > width ? width - 2 : x + barWidth / 2}
                  y={HEIGHT - 8}
                  textAnchor={x + barWidth / 2 + 20 > width ? "end" : "middle"}
                  className="fill-muted text-[11px]"
                >
                  {d.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Hit targets: one real button per day, covering the whole column (not just the painted
          bar), so the same readout appears on hover and on keyboard focus. */}
      <div className="absolute inset-0">
        {days.map((d, i) => (
          <button
            key={d.day}
            type="button"
            aria-label={`${d.label}: ${d.findings} new ${d.findings === 1 ? "finding" : "findings"}`}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            className="absolute rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-secondary)]"
            style={{
              left: MARGIN.left + i * band,
              top: MARGIN.top,
              width: band,
              height: innerHeight,
            }}
          />
        ))}
      </div>

      {current && active !== null ? (
        <div
          role="status"
          className="pointer-events-none absolute rounded-lg bg-surface px-3 py-2 text-sm shadow-lg ring-1 ring-gridline"
          style={{
            left: Math.min(width - 140, Math.max(0, MARGIN.left + active * band + band / 2 - 70)),
            top: 0,
            width: 140,
          }}
        >
          <p className="font-semibold text-ink">
            {current.findings} new {current.findings === 1 ? "finding" : "findings"}
          </p>
          <p className="text-secondary">{current.label}</p>
        </div>
      ) : null}
    </div>
  );
}
