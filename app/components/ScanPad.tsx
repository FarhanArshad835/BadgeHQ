/**
 * The scanning surface: one input, one big verdict, one session list.
 *
 * Built for a bench, not a desk. A barcode gun types the code and presses Enter,
 * so the input must always hold focus and never need a click. The verdict panel
 * is large and colour-coded, with a distinct sound per outcome, because the
 * operator is looking at the packet and not the screen.
 *
 * Speed comes from answering locally first. The dispatched-AWB set is preloaded
 * (~3,000 codes, ~45KB), so "already dispatched" is decided with no network at
 * all; the server call still happens, and still has the final say, but the
 * operator has already seen a result.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type ScanKind = "dispatch" | "rto" | "customer-return" | "inbound";

export type ScanRow = {
  awb: string;
  result: string;
  message: string;
  orderName: string;
  /** What the server decided this parcel is. Blank until it answers. */
  kind: string;
  at: string;
  /** False until the server confirms. Never shown as a success. */
  saved: boolean;
};

const KIND_LABEL: Record<string, string> = {
  rto: "RTO",
  "customer-return": "CUSTOMER RETURN",
  dispatch: "DISPATCH",
};

const TONES: Record<string, { hz: number; ms: number; times: number }> = {
  ok: { hz: 880, ms: 90, times: 1 },
  duplicate: { hz: 320, ms: 160, times: 2 },
  blocked: { hz: 180, ms: 300, times: 3 },
  "not-found": { hz: 520, ms: 140, times: 2 },
  error: { hz: 160, ms: 400, times: 1 },
};

/** A short tone per outcome, so the bench can work by ear. */
function beep(kind: string) {
  const tone = TONES[kind] || TONES.ok;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    for (let i = 0; i < tone.times; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = tone.hz;
      const start = ctx.currentTime + i * (tone.ms + 60) / 1000;
      gain.gain.setValueAtTime(0.2, start);
      osc.start(start);
      osc.stop(start + tone.ms / 1000);
    }
    setTimeout(() => ctx.close().catch(() => {}), tone.times * (tone.ms + 80) + 200);
  } catch {
    /* audio is a nicety; never let it break a scan */
  }
}

const PANEL: Record<string, { bg: string; fg: string; label: string }> = {
  idle: { bg: "#f1f0ee", fg: "#52514e", label: "Ready" },
  ok: { bg: "#1a7f37", fg: "#ffffff", label: "OK" },
  duplicate: { bg: "#b1660a", fg: "#ffffff", label: "DUPLICATE" },
  blocked: { bg: "#b42318", fg: "#ffffff", label: "STOP" },
  "not-found": { bg: "#54308a", fg: "#ffffff", label: "RECORDED" },
  error: { bg: "#b42318", fg: "#ffffff", label: "NOT SAVED" },
};

/** Thrown when the action reports the scanner session has lapsed. */
class SessionExpired extends Error {}

/**
 * Pull the action's payload out of a single-fetch response.
 *
 * Remix answers .data with turbo-stream: a flat array where objects hold
 * INDEXES into that array rather than values, so {"_1":2} means "key at [1],
 * value at [2]". Resolving those references is all this needs to do; the
 * payload here is one flat object of strings.
 */
function decodeTurboStream(text: string): any {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) return parsed;
  const at = (i: unknown): any => {
    const v = parsed[i as number];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, any> = {};
      for (const [k, ref] of Object.entries(v)) {
        out[typeof k === "string" && k.startsWith("_") ? at(Number(k.slice(1))) : k] = at(ref);
      }
      return out;
    }
    return v;
  };
  // [0] is the root: {"_1":2} -> { data: <payload> }
  const root = at(0);
  return root?.data ?? root;
}

export function ScanPad({
  kind,
  title,
  hint,
  dispatched,
}: {
  kind: ScanKind;
  title: string;
  hint: string;
  /** Preloaded already-dispatched AWBs. Empty for non-dispatch scanners. */
  dispatched?: string[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [panel, setPanel] = useState<{
    state: string;
    awb: string;
    message: string;
    kind: string;
    confident: boolean;
    signedOut?: boolean;
  }>({ state: "idle", awb: "", message: hint, kind: "", confident: true });
  const [pending, setPending] = useState(0);
  // Refusals are counted but not listed: the operator needs to know the pile
  // had some, without rows for packets that were never dispatched.
  const [refused, setRefused] = useState(0);

  // A Set, built once: 3,000 linear scans per keystroke would defeat the point.
  const dispatchedSet = useRef<Set<string>>(new Set());
  useEffect(() => {
    dispatchedSet.current = new Set(dispatched || []);
  }, [dispatched]);

  /**
   * Start a fresh session.
   *
   * Clears only what is on screen — the list, the counters, the panel. The
   * scans themselves stay recorded, and the duplicate check still sees them,
   * so this cannot be used to sneak a packet through twice. It exists because
   * a bench works in batches: finish a trolley, reset the tally, start the
   * next one against a count that means something.
   */
  const startNewSession = useCallback(() => {
    setRows([]);
    setRefused(0);
    setPending(0);
    setPanel({ state: "idle", awb: "", message: hint, kind: "", confident: true });
    inputRef.current?.focus();
  }, [hint]);

  const dismiss = useCallback(
    () => setPanel({ state: "idle", awb: "", message: hint, kind: "", confident: true }),
    [hint],
  );

  // A refusal BLOCKS scanning until it is dismissed. It used to clear itself
  // after six seconds, which is wrong for something the operator must act on:
  // the packet has to come off the pile, and a gun firing the next barcode a
  // second later would bury the warning before it was read.
  const halted = panel.state === "duplicate" || panel.state === "blocked";

  // The gun types into whatever has focus, so the input must hold it — but not
  // at the cost of every other control on the page. Stealing focus back from a
  // textarea the operator has deliberately clicked makes that field unusable:
  // a pasted list lands in the scan box instead, where the whole list is read
  // as one barcode.
  const stealsFocusFrom = (el: Element | null) =>
    !el ||
    el === document.body ||
    !(
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.tagName === "BUTTON" ||
      el.tagName === "A" ||
      (el as HTMLElement).isContentEditable
    );

  const refocus = useCallback(() => {
    // A disabled input cannot hold focus, and trying is what would let the
    // gun's next barcode land somewhere else on the page.
    if (inputRef.current?.disabled) return;
    if (!stealsFocusFrom(document.activeElement)) return;
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    const t = setInterval(refocus, 1500);
    return () => clearInterval(t);
  }, [refocus]);

  const submit = useCallback(
    async (raw: string) => {
      // A list pasted here is not a barcode. Without this the separators are
      // stripped and several AWBs are recorded as one impossible code, which
      // then has to be deleted by hand. Say so instead of filing it.
      if (/[\n\r\t,;]/.test(raw.trim())) {
        setPanel({
          state: "error",
          awb: "",
          kind: "",
          confident: true,
          message: "That looks like a list. Use “Paste a list of AWBs” below instead.",
        });
        beep("error");
        return;
      }

      const awb = raw.replace(/[^0-9a-zA-Z]/g, "");
      if (awb.length < 6) return;

      // A real AWB is ~11-16 characters. Much longer means several were run
      // together by a paste that lost its separators.
      if (awb.length > 24) {
        setPanel({
          state: "error",
          awb: awb.slice(0, 24) + "…",
          kind: "",
          confident: true,
          message: "Too long for one AWB — looks like several joined together. Use the paste box below.",
        });
        beep("error");
        return;
      }

      // Answer locally where we can, so the common case has no latency at all.
      const localBlocked = kind === "dispatch" && dispatchedSet.current.has(awb);
      const alreadyInSession = rows.some((r) => r.awb === awb && r.saved);
      const optimistic = localBlocked ? "blocked" : alreadyInSession ? "duplicate" : "ok";

      setPanel({
        state: optimistic,
        awb,
        kind: "",
        confident: true,
        message:
          optimistic === "blocked"
            ? "ALREADY DISPATCHED. Do not send this packet again."
            : optimistic === "duplicate"
              ? "Already scanned in this session."
              : kind === "inbound"
                ? "Checking…"
                : "Saving…",
      });
      beep(optimistic);

      // A refusal never enters the list. Both "duplicate" and "blocked" mean
      // the packet was NOT dispatched, so a row for either would be a record
      // of something that did not happen — and the count already excluded
      // them, so the list and the tally disagreed.
      if (optimistic === "duplicate" || optimistic === "blocked") setRefused((n) => n + 1);
      if (optimistic !== "duplicate" && optimistic !== "blocked") {
        const row: ScanRow = {
          awb,
          result: optimistic,
          message: "",
          orderName: "",
          kind: "",
          at: new Date().toLocaleTimeString(),
          saved: false,
        };
        setRows((r) => [row, ...r].slice(0, 200));
      }
      setPending((n) => n + 1);

      try {
        // Posts to the route's single-fetch .data endpoint, NOT to the route
        // path. A plain fetch("") POST is a DOCUMENT request: Remix runs the
        // action, revalidates, and answers with a full HTML page. The scan
        // saved, but res.json() then choked on HTML and the operator was told
        // NOT SAVED for a scan that had in fact been recorded — the worst
        // possible direction for this panel to be wrong in.
        const res = await fetch(window.location.pathname + ".data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ awb, kind }),
          credentials: "same-origin",
        });
        // A lapsed session answers 401 here rather than redirecting, so it can
        // be named instead of being reported as a network fault.
        if (res.status === 401) throw new SessionExpired();
        if (!res.ok) throw new Error(String(res.status));
        const data = decodeTurboStream(await res.text());

        // The server has the last word: it can see duplicates from other devices.
        if (data.result === "duplicate" || data.result === "blocked") {
          // Only when the server disagrees with an optimistic OK; otherwise it
          // was already counted above.
          if (optimistic !== "duplicate" && optimistic !== "blocked") setRefused((n) => n + 1);
          // Nothing was dispatched, so nothing belongs in the list. Leaving a
          // row would imply a scan happened and would disagree with the count
          // the operator checks their pile against.
          setRows((r) => r.filter((x) => !(x.awb === awb && !x.saved)));
        } else {
          setRows((r) =>
            r.map((x) =>
              x.awb === awb && !x.saved
                ? {
                    ...x,
                    result: data.result,
                    message: data.message,
                    orderName: data.orderName,
                    kind: data.kind || "",
                    saved: true,
                  }
                : x,
            ),
          );
        }
        if (data.result !== optimistic) beep(data.result);
        setPanel({
          state: data.result,
          awb,
          message: data.message,
          kind: data.kind || "",
          confident: data.confident !== false,
        });
      } catch (err) {
        // Never let a failed write look like a success.
        const expired = err instanceof SessionExpired;
        setRows((r) => r.map((x) => (x.awb === awb && !x.saved ? { ...x, result: "error" } : x)));
        setPanel({
          state: "error",
          awb,
          kind: "",
          confident: true,
          signedOut: expired,
          message: expired
            ? "NOT SAVED — you have been signed out. Log in again, then scan this packet."
            : "NOT SAVED. Check the connection and scan this packet again.",
        });
        beep("error");
      } finally {
        setPending((n) => Math.max(0, n - 1));
        refocus();
      }
    },
    [kind, rows, refocus],
  );

  const look = PANEL[panel.state] || PANEL.idle;
  // Refusals never reach the list now, so this counts exactly what it shows.
  const savedCount = rows.filter((r) => r.saved).length;
  const unsaved = rows.filter((r) => r.result === "error").length;

  return (
    <div className="pnl-scan">
      {/* A refusal stops the bench. Rendered over the page rather than inline
          so it cannot be scrolled past, and the dismiss button takes focus so
          the gun's Enter clears it instead of firing a scan into nothing. */}
      {halted && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label={look.label}
          onClick={() => { dismiss(); refocus(); }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "rgba(20,20,25,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: look.bg,
              color: look.fg,
              borderRadius: 10,
              padding: "28px 32px",
              maxWidth: 560,
              width: "100%",
              textAlign: "center",
              boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em" }}>
              {look.label}
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                margin: "10px 0",
                fontVariantNumeric: "tabular-nums",
                wordBreak: "break-all",
              }}
            >
              {panel.awb}
            </div>
            <div style={{ fontSize: 15, marginBottom: 20 }}>{panel.message}</div>
            <button
              type="button"
              autoFocus
              className="pnl-btn"
              onClick={() => { dismiss(); refocus(); }}
              onKeyDown={(e) => {
                // The gun sends Enter after a code. If it fires while this is
                // open, dismissing is the right thing to do with it.
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  dismiss();
                  refocus();
                }
              }}
              style={{ fontSize: 16, padding: "10px 28px" }}
            >
              Set aside and carry on
            </button>
          </div>
        </div>
      )}
      <div className="pnl-scan-head">
        <h1 className="pnl-h1" style={{ fontSize: 20, margin: 0 }}>{title}</h1>
        <div className="pnl-scan-counts">
          {/* The session tally, big enough to read from the bench. It is what
              an operator counts their physical pile against, so it states the
              number rather than mentioning it. */}
          <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <strong style={{ fontSize: 26, lineHeight: 1 }}>{savedCount}</strong>
            <span>scanned this session</span>
          </span>
          {refused > 0 && (
            <span className="pnl-sub" style={{ fontSize: 12 }}>
              {refused} refused
            </span>
          )}
          {pending > 0 && <span className="pnl-scan-pending">{pending} saving…</span>}
          {unsaved > 0 && <span className="pnl-scan-unsaved">{unsaved} NOT SAVED</span>}
          {rows.length > 0 && (
            <button
              type="button"
              className="pnl-btn"
              onClick={() => {
                // Only worth confirming once there is something to lose.
                if (unsaved > 0 && !confirm(`${unsaved} scan(s) were NOT saved. Start a new session anyway?`)) return;
                startNewSession();
              }}
              style={{ fontSize: 12, padding: "4px 10px" }}
            >
              New session
            </button>
          )}
        </div>
      </div>

      <div className="pnl-scan-panel" style={{ background: look.bg, color: look.fg }}>
        <div className="pnl-scan-verdict">
          {panel.kind && KIND_LABEL[panel.kind] ? KIND_LABEL[panel.kind] : look.label}
          {panel.kind && !panel.confident && <span className="pnl-scan-unsure"> — CHECK</span>}
        </div>
        <div className="pnl-scan-awb">{panel.awb || " "}</div>
        <div className="pnl-scan-msg">{panel.message}</div>
        {/* A signed-out operator should not have to know the URL. */}
        {panel.signedOut && (
          <a
            className="pnl-btn"
            href="/pnl-app/scan/login"
            style={{ marginTop: 10, display: "inline-block" }}
          >
            Log in again
          </a>
        )}
      </div>

      <input
        ref={inputRef}
        className="pnl-scan-input"
        disabled={halted}
        placeholder={halted ? "Dismiss the warning to carry on" : "Scan a barcode"}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            (e.target as HTMLInputElement).value = "";
            dismiss();
            return;
          }
          // Guns send Enter after the code. Everything else is a normal keypress.
          if (e.key !== "Enter") return;
          e.preventDefault();
          const v = (e.target as HTMLInputElement).value;
          (e.target as HTMLInputElement).value = "";
          void submit(v);
        }}
        // Deferred: at blur time the new target is not focused yet, so checking
        // immediately would always look like focus went nowhere and pull it back.
        onBlur={() => setTimeout(refocus, 0)}
      />

      <div className="pnl-scan-list">
        {rows.length === 0 ? (
          <p className="pnl-sub" style={{ margin: 0 }}>Scans from this session appear here.</p>
        ) : (
          rows.map((r, i) => (
            <div key={r.awb + i} className={`pnl-scan-row pnl-scan-row--${r.result}`}>
              <span className="pnl-scan-row-awb">{r.awb}</span>
              <span className="pnl-scan-row-order">{r.orderName || (r.saved ? "not in orders" : "")}</span>
              <span className="pnl-scan-row-time">{r.at}</span>
              <span className="pnl-scan-row-state">
                {r.result === "error"
                  ? "NOT SAVED"
                  : r.saved
                    ? KIND_LABEL[r.kind] || r.result
                    : "…"}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
