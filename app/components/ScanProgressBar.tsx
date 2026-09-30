/**
 * How much of what the courier returned we have actually seen.
 *
 * A part-to-whole: one bar, the courier's total, split into the part our bench
 * physically confirmed and the part still unaccounted for. Two separate bars
 * would invite reading them as unrelated totals; one bar makes the denominator
 * the courier's claim, which is the whole point — every parcel in the dark
 * segment is stock they say they gave us and nobody has seen.
 *
 * The unscanned share leads, because it is the number that costs money. It is
 * stated as a figure as well as a proportion: a bar answers "how bad" at a
 * glance, and the count answers "how much" when someone acts on it.
 */

/** Validated for CVD (deutan ΔE 19.9) and contrast against the panel surface. */
const SCANNED = "oklch(0.55 0.13 160)";
const UNSCANNED = "oklch(0.52 0.15 275)";

export function ScanProgressBar({
  scanned,
  unscanned,
  undated,
  graceDays,
  noun = "returned",
}: {
  scanned: number;
  unscanned: number;
  /** Returned parcels with no courier date — outside the bar, not part of it. */
  undated: number;
  graceDays: number;
  /** Verb for how the parcel came back, so the sentence reads true per tab. */
  noun?: string;
}) {
  const total = scanned + unscanned;
  if (total === 0) return null;

  const pctScanned = (scanned / total) * 100;
  const pctUnscanned = 100 - pctScanned;
  const fmt = (n: number) => n.toLocaleString("en-IN");

  // Below this a segment is too thin to hold its own label legibly, so the
  // label moves out rather than overflowing its own segment.
  const INSIDE = 12;

  return (
    <div className="pnl-panel" style={{ marginBottom: 14 }}>
      <div className="pnl-section-label">Stock the courier says we have</div>

      {/* The headline is a sentence, not a caption: the number, then what it
          means, in the order someone reads it. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1 }}>{fmt(unscanned)}</div>
        <div style={{ fontSize: 15 }}>
          parcels are missing.{" "}
          <span className="pnl-sub">
            The courier {noun} them over {graceDays} days ago and nobody here has seen them.
          </span>
        </div>
      </div>

      {/* One bar, two segments, 2px surface gap between the fills. */}
      <div
        role="img"
        aria-label={`${fmt(scanned)} of ${fmt(total)} returned parcels scanned in, ${fmt(unscanned)} not`}
        style={{
          display: "flex",
          gap: 2,
          height: 34,
          marginTop: 14,
          borderRadius: 5,
          overflow: "hidden",
          background: "var(--line-soft)",
        }}
      >
        {scanned > 0 && (
          <div
            title={`Scanned in: ${fmt(scanned)} (${pctScanned.toFixed(1)}%)`}
            style={{
              width: `${pctScanned}%`,
              background: SCANNED,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 650,
              whiteSpace: "nowrap",
            }}
          >
            {pctScanned >= INSIDE ? `${pctScanned.toFixed(1)}%` : ""}
          </div>
        )}
        {unscanned > 0 && (
          <div
            title={`Not scanned: ${fmt(unscanned)} (${pctUnscanned.toFixed(1)}%)`}
            style={{
              width: `${pctUnscanned}%`,
              background: UNSCANNED,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 650,
              whiteSpace: "nowrap",
            }}
          >
            {pctUnscanned >= INSIDE ? `${pctUnscanned.toFixed(1)}%` : ""}
          </div>
        )}
      </div>

      {/* Legend with counts: identity never rests on colour alone. */}
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 12 }}>
        <LegendItem color={SCANNED} label="Found" value={fmt(scanned)} note="scanned at the bench" />
        <LegendItem
          color={UNSCANNED}
          label="Missing"
          value={fmt(unscanned)}
          note="claim these from the courier"
        />
        {undated > 0 && (
          <LegendItem
            color="var(--line)"
            label="Can't tell yet"
            value={fmt(undated)}
            note="courier gave no return date"
          />
        )}
      </div>
    </div>
  );
}

function LegendItem({
  color,
  label,
  value,
  note,
}: {
  color: string;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: 2,
          background: color,
          marginTop: 5,
          flexShrink: 0,
        }}
      />
      <div>
        <div style={{ fontSize: 17, fontWeight: 650, lineHeight: 1.2 }}>{value}</div>
        <div className="pnl-sub" style={{ fontSize: 12 }}>
          {label} · {note}
        </div>
      </div>
    </div>
  );
}
