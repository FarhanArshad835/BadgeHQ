/**
 * Daily trend for any counted event (wishlist saves, signups, replies). Hand-rolled inline SVG: this is the app's only
 * chart, so a charting dependency would be a lot of weight for one area plot.
 *
 * Single series, so no legend (the heading names it) and a sequential blue
 * rather than a categorical hue. Palette validated against the light surface.
 *
 * Interaction: a crosshair snaps to the nearest day and a tooltip reads out the
 * value. Every value is ALSO in the table below, so nothing is reachable only by
 * hovering — which is what makes this usable by keyboard and screen readers.
 */
import { useState } from "react";

type Point = { day: string; adds: number };

const SERIES = "#2a78d6"; // sequential blue, validated
const GRID = "#e3e3e0";
const INK_MUTED = "#52514e";

const W = 720;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 40 };

/** "2026-09-05" to "5 Sep" — axis labels must not wrap. */
function shortDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

export function DailyTrend({ points, noun = "saves" }: { points: Point[]; noun?: string }) {
  const [hover, setHover] = useState<number | null>(null);

  if (!points.length) return null;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...points.map((p) => p.adds));
  // Round the axis top up to something readable rather than the raw maximum.
  const niceMax = max <= 5 ? 5 : Math.ceil(max / 5) * 5;

  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = (v: number) => PAD.top + plotH - (v / niceMax) * plotH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.adds)}`).join(" ");
  const area = `${line} L${x(points.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`;

  // Four gridlines is enough to read a value against without becoming a ladder.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));

  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`${noun} per day. ${points.map((p) => `${shortDay(p.day)}: ${p.adds}`).join(". ")}`}
        style={{ display: "block", overflow: "visible" }}
        onMouseLeave={() => setHover(null)}
      >
        {/* Recessive grid: present enough to measure against, quiet enough to
            stay behind the data. */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={INK_MUTED}>
              {t}
            </text>
          </g>
        ))}

        <path d={area} fill={SERIES} fillOpacity={0.14} />
        <path d={line} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {points.map((p, i) => (
          <g key={p.day}>
            {i === hover && (
              <line x1={x(i)} x2={x(i)} y1={PAD.top} y2={PAD.top + plotH} stroke={SERIES} strokeWidth={1} strokeDasharray="3 3" />
            )}
            {/* A 2px surface ring keeps the marker readable where it sits on the line. */}
            <circle
              cx={x(i)}
              cy={y(p.adds)}
              r={i === hover ? 5 : 3.5}
              fill={SERIES}
              stroke="#fcfcfb"
              strokeWidth={2}
            />
            {/* Hit target far wider than the mark: nobody reliably hits 8px. */}
            <rect
              x={x(i) - plotW / (points.length * 2)}
              y={PAD.top}
              width={plotW / points.length}
              height={plotH}
              fill="transparent"
              tabIndex={0}
              role="button"
              aria-label={`${shortDay(p.day)}: ${p.adds} ${noun}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              style={{ cursor: "default", outline: "none" }}
            />
            {/* Label the ends only: a number on every point is noise. */}
            {(i === 0 || i === points.length - 1) && (
              <text x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : "end"} fontSize={11} fill={INK_MUTED}>
                {shortDay(p.day)}
              </text>
            )}
          </g>
        ))}
      </svg>

      {hover !== null && (
        <div
          style={{
            position: "absolute",
            left: `${(x(hover) / W) * 100}%`,
            top: 0,
            transform: "translateX(-50%)",
            background: "#1a1a19",
            color: "#fff",
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 12,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {/* Value leads, label follows: the reader already knows the series. */}
          <strong style={{ fontSize: 14 }}>{points[hover].adds}</strong> {noun}
          <div style={{ opacity: 0.75 }}>{shortDay(points[hover].day)}</div>
        </div>
      )}
    </div>
  );
}
