/**
 * Bot vs team, day by day.
 *
 * Stacked bars rather than two lines: the question is composition ("how much of
 * each day did the bot carry, and is that drifting?"), and a stack answers it
 * directly, with total height still readable as volume. Two lines would make the
 * reader do the addition themselves.
 *
 * Two series, so a legend is always present and both are direct-labelled in the
 * tooltip. Identity never rests on colour alone. Palette validated against both
 * the light and dark surfaces (protan ΔE 26.6).
 */
import { useState } from "react";

type Point = { day: string; bot: number; human: number };

const BOT = "#2a78d6";
const HUMAN = "#b1660a";
const GRID = "#e3e3e0";
const INK_MUTED = "#52514e";
const SURFACE = "#fcfcfb";

const W = 720;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 44, left: 40 };

/** "2026-09-05" to "5 Sep" — axis labels must not wrap. */
function shortDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{ width: 10, height: 10, borderRadius: 2, background: color, flex: "0 0 auto" }}
      />
      <span style={{ fontSize: 12, color: INK_MUTED }}>{label}</span>
    </span>
  );
}

export function SplitTrend({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (!points.length) return null;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...points.map((p) => p.bot + p.human));
  // Round the axis top up to something readable rather than the raw maximum.
  const niceMax = max <= 5 ? 5 : Math.ceil(max / 5) * 5;

  const y = (v: number) => PAD.top + plotH - (v / niceMax) * plotH;
  const band = plotW / points.length;
  // Thin marks: a gap between bars keeps adjacent days from reading as one mass.
  const barW = Math.max(2, Math.min(28, band - 4));
  const cx = (i: number) => PAD.left + band * i + band / 2;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));

  const totals = points.reduce(
    (acc, p) => ({ bot: acc.bot + p.bot, human: acc.human + p.human }),
    { bot: 0, human: 0 },
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 8 }}>
        <Swatch color={BOT} label="Bot" />
        <Swatch color={HUMAN} label="Handed to your team" />
      </div>

      <div style={{ position: "relative" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Replies by the bot and chats handed to your team, per day. ${points
            .map((p) => `${shortDay(p.day)}: bot ${p.bot}, team ${p.human}`)
            .join(". ")}`}
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

          {points.map((p, i) => {
            const total = p.bot + p.human;
            const botTop = y(total);
            const botH = Math.max(0, y(p.human) - y(total));
            const humanH = Math.max(0, y(0) - y(p.human));
            return (
              <g key={p.day}>
                {/* Team sits at the base so its segment shares the baseline and
                    stays comparable across days even when it is small. */}
                {p.human > 0 && (
                  <rect
                    x={cx(i) - barW / 2}
                    y={y(p.human)}
                    width={barW}
                    height={humanH}
                    fill={HUMAN}
                    rx={p.bot === 0 ? 3 : 0}
                  />
                )}
                {p.bot > 0 && (
                  <rect
                    x={cx(i) - barW / 2}
                    y={botTop}
                    width={barW}
                    height={botH}
                    fill={BOT}
                    rx={3}
                  />
                )}
                {/* A 2px surface gap so the two segments never read as one bar. */}
                {p.bot > 0 && p.human > 0 && (
                  <rect
                    x={cx(i) - barW / 2}
                    y={y(p.human) - 1}
                    width={barW}
                    height={2}
                    fill={SURFACE}
                  />
                )}
                {/* Hit target spans the full band and height: nobody reliably
                    hits a 6px-wide bar, and a short day would be unhoverable. */}
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${shortDay(p.day)}: bot ${p.bot}, handed to your team ${p.human}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  style={{ cursor: "default", outline: "none" }}
                />
                {/* Label the ends only: a date under every bar is noise. */}
                {(i === 0 || i === points.length - 1) && (
                  <text
                    x={cx(i)}
                    y={H - 26}
                    textAnchor={i === 0 ? "start" : "end"}
                    fontSize={11}
                    fill={INK_MUTED}
                  >
                    {shortDay(p.day)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {hover !== null && (
          <div
            style={{
              position: "absolute",
              left: `${(cx(hover) / W) * 100}%`,
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
            <div style={{ opacity: 0.75, marginBottom: 2 }}>{shortDay(points[hover].day)}</div>
            <div>
              <strong style={{ fontSize: 14 }}>{points[hover].bot}</strong> by the bot
            </div>
            <div>
              <strong style={{ fontSize: 14 }}>{points[hover].human}</strong> to your team
            </div>
          </div>
        )}
      </div>

      {/* The share is the point of the chart, so it is stated as well as drawn:
          reading a percentage off stacked heights is exactly what people get
          wrong, and it keeps the figure available without hovering. */}
      <div style={{ marginTop: 8, fontSize: 12, color: INK_MUTED }}>
        {totals.bot + totals.human > 0
          ? `Over this period the bot finished ${Math.round(
              (totals.bot / (totals.bot + totals.human)) * 100,
            )}% of conversations without a person.`
          : "Nothing recorded in this period."}
      </div>
    </div>
  );
}
