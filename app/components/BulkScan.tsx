/**
 * Paste a list of AWBs instead of scanning them one at a time.
 *
 * For a pile worked through offline, or a backlog the gun never saw. Collapsed
 * by default: the bench's normal path is the scanner above it, and a text box
 * competing for attention is a text box an operator will type a barcode into by
 * mistake.
 *
 * Every AWB goes through the same recordScan the gun uses, so detection, the
 * duplicate constraint and the not-found path behave identically. This is a
 * different way in, not a looser one.
 */
import { useState } from "react";

type Outcome = {
  awb: string;
  kind: string;
  result: string;
  message: string;
  orderName: string;
};

const RESULT_LABEL: Record<string, string> = {
  ok: "recorded",
  duplicate: "already scanned",
  "not-found": "recorded, not in orders",
  blocked: "blocked",
};

export function BulkScan({ kind, label }: { kind: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<{
    counts: Record<string, number>;
    results: Outcome[];
    skipped: number;
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState("");

  const lineCount = text.split(/[^0-9a-zA-Z]+/).filter((x) => x.length >= 6).length;

  async function submit() {
    if (!lineCount || busy) return;
    setBusy(true);
    setError("");
    setReport(null);

    // Sent in chunks rather than one request. Each AWB is checked against
    // ReturnHQ and the orders table, so a few hundred takes long enough that a
    // single silent request looks hung — and a connection that drops halfway
    // would lose the whole list with nothing to show for it. Chunking gives
    // real progress and keeps whatever already landed.
    //
    // Five, not twenty-five: the bar moves five times as often, and a drop
    // costs at most four recorded AWBs of uncertainty rather than twenty-four.
    // The extra round trips are cheap next to the per-AWB lookups they carry.
    const CHUNK = 5;
    const awbs = text.split(/[^0-9a-zA-Z]+/).filter((x) => x.length >= 6);
    const merged = {
      counts: {} as Record<string, number>,
      results: [] as Outcome[],
      skipped: 0,
      truncated: false,
    };
    setProgress({ done: 0, total: awbs.length });

    try {
      for (let i = 0; i < awbs.length; i += CHUNK) {
        const slice = awbs.slice(i, i + CHUNK);
        // Same .data endpoint the gun posts to: a route-path POST is a
        // document request and answers with HTML.
        const res = await fetch(window.location.pathname + ".data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bulk: slice.join("\n"), kind }),
          credentials: "same-origin",
        });
        if (res.status === 401) {
          setError(
            merged.results.length
              ? `You were signed out after ${merged.results.length} of ${awbs.length}. Log in again and paste the rest.`
              : "You have been signed out. Log in again, then paste the list.",
          );
          break;
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = decodeTurboStream(await res.text());
        if (data?.error) { setError(String(data.error)); break; }

        merged.results.push(...(data.results || []));
        merged.skipped += data.skipped || 0;
        for (const [k, n] of Object.entries(data.counts || {})) {
          merged.counts[k] = (merged.counts[k] || 0) + (n as number);
        }
        // Shown as it goes, so a long list is visibly working.
        setProgress({ done: Math.min(i + CHUNK, awbs.length), total: awbs.length });
        setReport({ ...merged, results: [...merged.results] });
      }
      if (merged.results.length) setText("");
    } catch {
      setError(
        merged.results.length
          ? `Stopped after ${merged.results.length} of ${awbs.length}. Those were saved; check the connection and paste the rest.`
          : "Nothing was saved. Check the connection and try the list again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pnl-panel" style={{ marginTop: 14 }}>
      <button
        type="button"
        className="pnl-link"
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit" }}
      >
        {open ? "▾" : "▸"} {label}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <textarea
            className="pnl-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"One AWB per line.\nPasting a column from a spreadsheet works."}
            rows={8}
            spellCheck={false}
            style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 13 }}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
            <button
              type="button"
              className="pnl-btn pnl-btn-primary"
              onClick={submit}
              disabled={busy || !lineCount}
            >
              {busy ? "Recording…" : `Record ${lineCount || ""} AWB${lineCount === 1 ? "" : "s"}`}
            </button>
            {busy && progress.total > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 180 }}>
                <div
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    background: "var(--line-soft)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${(progress.done / progress.total) * 100}%`,
                      height: "100%",
                      background: "var(--accent)",
                      transition: "width 200ms linear",
                    }}
                  />
                </div>
                <span className="pnl-sub" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                  {progress.done} of {progress.total}
                </span>
              </div>
            )}
          </div>

          {error && <div className="pnl-err" style={{ marginTop: 10 }}>{error}</div>}

          {report && (
            <div style={{ marginTop: 14 }}>
              <div className="pnl-section-label">Result</div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 6 }}>
                {Object.entries(report.counts).map(([k, n]) => (
                  <div key={k}>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>{n}</div>
                    <div className="pnl-sub">{RESULT_LABEL[k] || k}</div>
                  </div>
                ))}
              </div>

              {report.skipped > 0 && (
                <p className="pnl-sub" style={{ marginTop: 8 }}>
                  {report.skipped} entr{report.skipped === 1 ? "y was" : "ies were"} skipped as too
                  short or repeated in the list.
                </p>
              )}
              {report.truncated && (
                <div className="pnl-help" style={{ marginTop: 8 }}>
                  Only the first 500 were recorded. Paste the rest as a second list.
                </div>
              )}

              <div className="pnl-table-wrap" style={{ marginTop: 10, maxHeight: 320 }}>
                <table className="pnl-table">
                  <thead>
                    <tr>
                      <th>AWB</th>
                      <th>Order</th>
                      <th>Filed as</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.results.map((r, i) => (
                      <tr key={r.awb + i}>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.awb}</td>
                        <td>{r.orderName || <span className="pnl-muted">not in orders</span>}</td>
                        <td>{r.kind}</td>
                        <td>{RESULT_LABEL[r.result] || r.result}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pull the action's payload out of a single-fetch response.
 *
 * Remix answers .data with turbo-stream: a flat array where objects hold
 * INDEXES into that array rather than values.
 */
function decodeTurboStream(text: string): any {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) return parsed;
  const at = (i: unknown): any => {
    const v = parsed[i as number];
    if (Array.isArray(v)) return v.map((x) => at(x));
    if (v && typeof v === "object") {
      const out: Record<string, any> = {};
      for (const [k, ref] of Object.entries(v)) {
        out[typeof k === "string" && k.startsWith("_") ? at(Number(k.slice(1))) : k] = at(ref);
      }
      return out;
    }
    return v;
  };
  const root = at(0);
  return root?.data ?? root;
}
