/**
 * Bot vs team, day by day. Same line-and-area style as DailyTrend, drawn twice.
 *
 * Two series, so unlike DailyTrend this carries a legend and names both series
 * in the tooltip: identity never rests on colour alone. One shared crosshair
 * reads out BOTH values for a day, because the comparison is the whole point and
 * two separate hover targets would make the reader chase it.
 *
 * Palette validated against the light and dark surfaces (protan dE 26.6).
 */
import { useState } from "react";

type Point = { day: string; bot: number; human: number };

const BOT = "#2a78d6";
const HUMAN = "#b1660a";
const GRID = "#e3e3e0";
const INK_MUTED = "#52514e";
const SURFACE = "#fcfcfb";

const W = 720;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 40 };

/** "2026-09-05" to "5 Sep" — axis labels must not wrap. */
function shortDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flex: "0 0 auto" }} />
      <span style={{ fontSize: 12, color: INK_MUTED }}>{label}</span>
    </span>
  );
}

export function SplitTrend({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (!points.length) return null;
  // A single day has no slope to read and collapses the area, exactly as in
  // DailyTrend. Two numbers side by side say it better than a plot of one point.
  if (points.length === 1) {
    const p = points[0];
    return (
      <div style={{ padding: "24px 0", textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", gap: 32 }}>
          <div>
            <div style={{ fontSize: 32, fontWeight: 650, color: BOT }}>{p.bot}</div>
            <div style={{ fontSize: 13, color: INK_MUTED }}>by the bot</div>
          </div>
          <div>
            <div style={{ fontSize: 32, fontWeight: 650, color: HUMAN }}>{p.human}</div>
            <div style={{ fontSize: 13, color: INK_MUTED }}>to your team</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: INK_MUTED, marginTop: 8 }}>on {shortDay(p.day)}</div>
      </div>
    );
  }

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // One shared scale for both series: two y-scales would let a handful of
  // handovers look the same size as hundreds of bot replies.
  const max = Math.max(1, ...points.map((p) => Math.max(p.bot, p.human)));
  const niceMax = max <= 5 ? 5 : Math.ceil(max / 5) * 5;

  const x = (i: number) => PAD.left + (i * plotW) / (points.length - 1);
  const y = (v: number) => PAD.top + plotH - (v / niceMax) * plotH;

  const pathFor = (key: "bot" | "human") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p[key])}`).join(" ");
  const areaFor = (line: string) =>
    `${line} L${x(points.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`;

  const botLine = pathFor("bot");
  const humanLine = pathFor("human");

  // Four gridlines is enough to read a value against without becoming a ladder.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));

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

          {/* Team first, so the bot's larger series draws over it rather than
              hiding it. Fills are light enough to overlap without muddying. */}
          <path d={areaFor(humanLine)} fill={HUMAN} fillOpacity={0.12} />
          <path d={humanLine} fill="none" stroke={HUMAN} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={areaFor(botLine)} fill={BOT} fillOpacity={0.12} />
          <path d={botLine} fill="none" stroke={BOT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {points.map((p, i) => (
            <g key={p.day}>
              {i === hover && (
                <line
                  x1={x(i)}
                  x2={x(i)}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                  stroke={INK_MUTED}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
              )}
              {/* A 2px surface ring keeps each marker readable where the two
                  series cross. */}
              <circle cx={x(i)} cy={y(p.human)} r={i === hover ? 5 : 3.5} fill={HUMAN} stroke={SURFACE} strokeWidth={2} />
              <circle cx={x(i)} cy={y(p.bot)} r={i === hover ? 5 : 3.5} fill={BOT} stroke={SURFACE} strokeWidth={2} />
              {/* One hit target per DAY, spanning the full height: the crosshair
                  reads out both series at once, so they must not compete. */}
              <rect
                x={x(i) - plotW / (points.length * 2)}
                y={PAD.top}
                width={plotW / points.length}
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
              {/* Label the ends only: a date under every point is noise. */}
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
    </div>
  );
}
