/**
 * The scanning surface, built to the approved prototype.
 *
 * Same markup, classes and behaviour: the verdict block that is a slim bar when
 * idle and a full panel with a result, the tally with its pills, the session
 * list with per-row retry, the paste box with chunked progress, and the modal
 * that stops the bench on a refusal.
 *
 * Built for a bench, not a desk. A barcode gun types the code and presses
 * Enter, so the input must always hold focus and never need a click — and when
 * it loses focus the page SAYS so, because a scanner that has silently stopped
 * listening is worse than one that is visibly paused.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type ScanKind = "dispatch" | "rto" | "customer-return" | "inbound";

type RowStatus = "saving" | "ok" | "check" | "notfound" | "error";

type Row = {
  awb: string;
  time: Date;
  status: RowStatus;
  order: string | null;
  label: string;
  fresh: boolean;
};

type Verdict = { cls: string; label: string; awb: string; msg: string };

/** One sound per outcome, so the bench can work by ear. */
const SOUNDS: Record<string, Array<[number, number, OscillatorType]>> = {
  ok: [[1046, 0.09, "sine"]],
  check: [
    [1046, 0.09, "sine"],
    [523, 0.2, "sine"],
  ],
  notfound: [
    [784, 0.09, "sine"],
    [1046, 0.09, "sine"],
    [784, 0.09, "sine"],
  ],
  duplicate: [
    [440, 0.13, "square"],
    [440, 0.13, "square"],
  ],
  blocked: [[196, 0.6, "sawtooth"]],
  error: [
    [660, 0.13, "triangle"],
    [440, 0.13, "triangle"],
    [262, 0.32, "triangle"],
  ],
};

let audioCtx: AudioContext | null = null;
function play(name: string) {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    let t = audioCtx.currentTime;
    for (const [f, d, type] of SOUNDS[name] || []) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + d + 0.02);
      t += d + 0.04;
    }
  } catch {
    /* audio is a nicety; never let it break a scan */
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "3 Oct 14:32" — the way a bench refers to a batch, not an opaque id. */
function newSessionName(): string {
  const d = new Date();
  const month = d.toLocaleDateString("en-GB", { month: "short" });
  return `${d.getDate()} ${month} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const fmtT = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtD = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + fmtT(d);
const parseList = (t: string) =>
  t
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const RES_LABEL: Record<string, string> = {
  saving: "Saving…",
  error: "Not saved",
  duplicate: "Duplicate",
  blocked: "Stop — already dispatched",
};

export function ScanPad({
  kind,
  title,
  hint,
  dispatched,
  alreadyScanned,
  toolbar,
}: {
  kind: ScanKind;
  title: string;
  hint: string;
  /** Preloaded already-dispatched AWBs. Empty for non-dispatch scanners. */
  dispatched?: string[];
  /** AWBs an earlier session already booked in, so a pasted list can drop them
   *  without spending a round trip each to be told what we already know. The
   *  server still has the final say. */
  alreadyScanned?: string[];
  /** The dispatch page's sync strip, rendered above the title. */
  toolbar?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [refused, setRefused] = useState(0);
  const [verdict, setVerdict] = useState<Verdict>({ cls: "idle", label: "Ready", awb: "", msg: hint });
  const [modal, setModal] = useState<{ type: string; label: string; awb: string; msg: string } | null>(null);
  const [listening, setListening] = useState(true);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [text, setText] = useState("");
  const [bulk, setBulk] = useState<{
    total: number;
    done: number;
    running: boolean;
    stopped: boolean;
    retry: string[];
    results: Array<{ awb: string; result: string; label: string; order: string | null }>;
  } | null>(null);
  const [kbOn, setKbOn] = useState(false);

  /**
   * The batch every scan is filed under.
   *
   * Created when the page loads rather than on the first scan: a session that
   * only exists once something is in it cannot be named, reopened or reported
   * on, and the operator has nothing to start over FROM. Named by the time it
   * opened, which is how a bench refers to one anyway ("the 2pm trolley").
   */
  const [session, setSession] = useState(() => newSessionName());
  // What the last paste skipped without asking the server.
  const [dropped, setDropped] = useState({ repeated: 0, known: 0 });

  // A Set, built once: several thousand linear scans per keystroke would defeat
  // the point of preloading the list at all.
  const dispatchedSet = useRef<Set<string>>(new Set());
  useEffect(() => {
    dispatchedSet.current = new Set(dispatched || []);
  }, [dispatched]);

  // A Set, built once: a linear scan per AWB over thousands would cost more
  // than the requests it saves.
  const scannedSet = useRef<Set<string>>(new Set());
  useEffect(() => {
    scannedSet.current = new Set(alreadyScanned || []);
  }, [alreadyScanned]);

  // Ignore a verdict from a scan the operator has already moved past.
  const seq = useRef(0);
  const modalAt = useRef(0);
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  const setV = useCallback((cls: string, label: string, awb: string, msg: string) => {
    setVerdict({ cls, label, awb, msg });
  }, []);

  /* ---------- Focus: the scan box always listens ---------- */
  const refocus = useCallback(() => {
    if (modal) return;
    const a = document.activeElement as HTMLElement | null;
    const typing =
      a &&
      a !== inputRef.current &&
      (a.tagName === "TEXTAREA" ||
        a.tagName === "SELECT" ||
        (a.tagName === "INPUT" && (a as HTMLInputElement).type !== "checkbox"));
    if (!typing) inputRef.current?.focus({ preventScroll: true });
    setListening(document.activeElement === inputRef.current);
  }, [modal]);

  useEffect(() => {
    const onClick = () => setTimeout(refocus, 0);
    const onFocusIn = () => setListening(document.activeElement === inputRef.current);
    document.addEventListener("click", onClick);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("focus", onClick);
    const t = setInterval(() => {
      if (!document.hidden) refocus();
    }, 1500);
    refocus();
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focus", onClick);
      clearInterval(t);
    };
  }, [refocus]);

  // Phones used with a Bluetooth gun keep the on-screen keyboard hidden.
  useEffect(() => {
    if (matchMedia("(pointer: coarse)").matches && inputRef.current) {
      inputRef.current.inputMode = "none";
    }
  }, []);

  /* ---------- Scanning ---------- */
  function openModal(type: string, label: string, awb: string, msg: string) {
    modalAt.current = Date.now();
    setModal({ type, label, awb, msg });
    setTimeout(() => dismissRef.current?.focus(), 0);
  }

  const closeModal = useCallback(() => {
    // The gun sends a trailing Enter or CR-LF after the code. Without this the
    // modal would dismiss itself before the operator had read a word of it.
    if (Date.now() - modalAt.current < 400) return;
    setModal(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  function refuse(type: string, code: string, msg: string, isBulk: boolean) {
    setRefused((n) => n + 1);
    const label = type === "blocked" ? "STOP" : "DUPLICATE";
    if (!isBulk) {
      setV(type, label, code, msg);
      play(type);
      openModal(type, label, code, msg);
    }
    return { result: type, label: RES_LABEL[type], order: null as string | null };
  }

  async function commit(row: Row, isBulk: boolean) {
    const mySeq = ++seq.current;
    setRows((rs) => rs.map((r) => (r.awb === row.awb ? { ...r, status: "saving" } : r)));
    if (!isBulk) setV("checking", "Saving", row.awb, "");

    try {
      // Posts to the route's single-fetch .data endpoint, NOT the route path: a
      // plain POST to the path is a DOCUMENT request, and Remix answers it with
      // a full HTML page that res.json() then chokes on — reporting NOT SAVED
      // for a scan that had in fact been recorded.
      // Retried once on a server-side failure. A scan can wait on up to three
      // carrier APIs, so a single slow one is a blip rather than a real fault
      // — and making the operator re-scan a packet for a blip is how a bench
      // loses trust in the panel. A 401 is not retried: the session is gone
      // and a second attempt fails the same way.
      let res = await fetch(window.location.pathname + ".data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ awb: row.awb, kind, session }),
        credentials: "same-origin",
      });
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 600));
        res = await fetch(window.location.pathname + ".data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ awb: row.awb, kind, session }),
          credentials: "same-origin",
        });
      }
      if (res.status === 401) throw new Error("unauthorized");
      if (!res.ok) throw new Error(String(res.status));
      const data = decodeTurboStream(await res.text());

      // Green means WRITTEN. The server says what it did; anything else is a
      // failure, including a reply it refused outright. This used to fall
      // through to "ok" for any unrecognised value — a missing result field
      // turned a dropped write into a green row, and one run showed "1,185
      // RTO" in the chips against 567 rows actually in the table.
      //
      // Only these four mean the server dealt with the scan. "ok" and
      // "not-found" were written; "duplicate" and "blocked" were refused on
      // purpose and are already on record.
      const WROTE = ["ok", "not-found", "duplicate", "blocked"];
      if (!data || data.error || !WROTE.includes(data.result)) {
        throw new Error(String(data?.error || data?.result || "no-result"));
      }

      const cls = data.result === "ok" ? (data.confident === false ? "check" : "ok") : data.result;
      const status: RowStatus =
        data.result === "not-found"
          ? "notfound"
          : data.result === "ok"
            ? data.confident === false
              ? "check"
              : "ok"
            : // duplicate / blocked keep their own colour, never green.
              (data.result as RowStatus);
      const label = listLabel(data);

      setRows((rs) =>
        rs.map((r) => (r.awb === row.awb ? { ...r, status, order: data.orderName || null, label } : r)),
      );
      if (!isBulk && mySeq === seq.current) {
        setV(
          status === "notfound" ? "notfound" : "ok",
          verdictLabel(data),
          row.awb,
          data.message || "",
        );
        play(status === "notfound" ? "notfound" : status === "check" ? "check" : "ok");
      }
      return { result: data.result as string, label, order: (data.orderName || null) as string | null };
    } catch {
      setRows((rs) => rs.map((r) => (r.awb === row.awb ? { ...r, status: "error" } : r)));
      if (!isBulk && mySeq === seq.current) {
        setV(
          "error",
          "NOT SAVED",
          row.awb,
          "The save didn't reach the server. Put this packet aside, then press Retry or scan it again.",
        );
        play("error");
      }
      return { result: "error", label: "Not saved", order: null as string | null };
    }
  }

  async function scan(raw: string, isBulk = false) {
    const code = String(raw).trim().replace(/\s+/g, "");
    if (!code) return null;
    seq.current++;

    const existing = rowsRef.current.find((r) => r.awb === code);
    // Re-scanning a failed save is a retry, not a duplicate.
    if (existing && existing.status === "error") return commit(existing, isBulk);
    if (existing) {
      return refuse(
        "duplicate",
        code,
        `Already scanned at ${fmtT(existing.time)} this session. Take this packet off the pile.`,
        isBulk,
      );
    }
    // Answered locally, so the commonest rejection costs no network at all.
    if (kind === "dispatch" && dispatchedSet.current.has(code)) {
      return refuse(
        "blocked",
        code,
        "Already dispatched. Take this packet off the pile — don't send it again.",
        isBulk,
      );
    }

    const row: Row = { awb: code, time: new Date(), status: "saving", order: null, label: "", fresh: !isBulk };
    rowsRef.current = [row, ...rowsRef.current];
    setRows((rs) => [row, ...rs]);
    setTimeout(() => setRows((rs) => rs.map((r) => (r.awb === code ? { ...r, fresh: false } : r))), 1000);
    return commit(row, isBulk);
  }

  /* ---------- Bulk paste, in chunks of five ---------- */
  /**
   * Drop what we already know is recorded, before anything is sent.
   *
   * Two kinds, both free to remove here: repeats inside the pasted list, and
   * AWBs an earlier session booked in. Each would otherwise cost a request to
   * be told what we already know — on a 1,200-row paste that is most of the
   * work, and the time is paid by an operator watching a progress bar.
   */
  function dedupe(codes: string[]): { list: string[]; repeated: number; known: number } {
    const seen = new Set<string>();
    const list: string[] = [];
    let repeated = 0;
    let known = 0;
    for (const a of codes) {
      if (seen.has(a)) { repeated++; continue; }
      seen.add(a);
      if (scannedSet.current.has(a)) { known++; continue; }
      list.push(a);
    }
    setDropped({ repeated, known });
    // Returned as well as stored: setState does not apply until the next
    // render, so runBulk reading `dropped` in this same tick would see the
    // PREVIOUS paste's counts — zero on the first press, which is exactly the
    // case that needs reporting.
    return { list, repeated, known };
  }

  async function runBulk(codes: string[], skippedCounts = { repeated: 0, known: 0 }) {
    if (bulk?.running) return;

    // Everything in the list was dropped as already-recorded. That is an
    // answer, not a no-op: a button that does nothing when pressed reads as
    // broken, and the operator has no way to tell the difference.
    if (!codes.length) {
      const skipped = skippedCounts.repeated + skippedCounts.known;
      setBulk({ total: 0, done: 0, running: false, stopped: false, retry: [], results: [] });
      setV(
        "ok",
        "ALREADY RECORDED",
        "",
        skipped
          ? `All ${skipped.toLocaleString("en-IN")} were already on record — ${skippedCounts.known.toLocaleString("en-IN")} scanned before, ${skippedCounts.repeated.toLocaleString("en-IN")} repeated in the list. Nothing to send.`
          : "Nothing in the box to record.",
      );
      play("ok");
      return;
    }
    seq.current++;
    let done = 0;
    const results: Array<{ awb: string; result: string; label: string; order: string | null }> = [];
    // Failures are collected, not fatal: the list finishes and these are
    // offered as a retry.
    const retryLater: string[] = [];
    setBulk({ total: codes.length, done: 0, running: true, stopped: false, retry: [], results: [] });
    setV("checking", "Recording list", "", `${codes.length} AWBs from the paste box, in chunks of 5.`);

    for (let i = 0; i < codes.length; i += 5) {
      const chunk = codes.slice(i, i + 5);
      const outs = await Promise.all(chunk.map((c) => scan(c, true)));
      outs.forEach((o, j) => o && results.push({ awb: chunk[j], ...o }));
      done += chunk.length;
      setBulk({ total: codes.length, done, running: true, stopped: false, retry: [], results: [...results] });

      // Carry on past a failed chunk: its AWBs are collected for the retry
      // button, but the rest of the list still records. Stopping on the first
      // error made one slow carrier call abandon a hundred good scans.
      const failed = chunk.filter((c, j) => outs[j] && outs[j]!.result === "error");
      if (failed.length) retryLater.push(...failed);

    }

    // A duplicate is not a failure: the packet IS recorded, from an earlier
    // scan or from earlier in this same list. Counting only new writes and
    // calling the rest unsaved read as "724 of these failed", which sent
    // someone looking for a problem that was not there.
    const newly = results.filter((r) => ["ok", "not-found"].includes(r.result)).length;
    const already = results.filter((r) => r.result === "duplicate").length;
    const blocked = results.filter((r) => r.result === "blocked").length;
    setBulk({
      total: codes.length,
      done,
      running: false,
      stopped: retryLater.length > 0,
      retry: retryLater,
      results,
    });
    // The skipped ones are counted here too, or the numbers would not add up
    // to what was pasted and the operator would be left wondering where the
    // rest went.
    const skipped = dropped.repeated + dropped.known;
    const parts = [`${newly.toLocaleString("en-IN")} newly recorded`];
    if (already + dropped.known) {
      parts.push(`${(already + dropped.known).toLocaleString("en-IN")} already scanned`);
    }
    if (dropped.repeated) {
      parts.push(`${dropped.repeated.toLocaleString("en-IN")} repeated in the list`);
    }
    if (blocked) parts.push(`${blocked.toLocaleString("en-IN")} blocked`);
    if (retryLater.length) parts.push(`${retryLater.length.toLocaleString("en-IN")} not saved`);
    setV(
      retryLater.length ? "error" : "ok",
      retryLater.length ? "SOME NOT SAVED" : "LIST RECORDED",
      `${(newly + already + skipped).toLocaleString("en-IN")} of ${(codes.length + skipped).toLocaleString("en-IN")} on record`,
      parts.join(" · "),
    );
    play(retryLater.length ? "error" : "ok");
    if (!retryLater.length) setText("");
  }

  function newSession() {
    const bad = rows.filter((r) => r.status === "error").length;
    if (bad && !confirm(`${bad} scan${bad > 1 ? "s were" : " was"} not saved. Start a new session anyway?`))
      return;
    // The scans stay recorded and the duplicate check still sees them, so this
    // cannot be used to put a packet through twice.
    setRows([]);
    setRefused(0);
    setBulk(null);
    seq.current++;
    // A fresh name, so the scans that follow are a separate batch on the
    // server as well as on screen.
    setSession(newSessionName());
    setV("idle", "Ready", "", hint);
    setTimeout(refocus, 0);
  }

  const scanned = rows.filter((r) => ["ok", "check", "notfound"].includes(r.status)).length;
  const saving = rows.filter((r) => r.status === "saving").length;
  const bad = rows.filter((r) => r.status === "error").length;
  const listCount = parseList(text).length;
  // What a press would actually send, so the button never promises work it
  // will then skip.
  const newCount = (() => {
    const seen = new Set<string>();
    let n = 0;
    for (const a of parseList(text)) {
      if (seen.has(a) || scannedSet.current.has(a)) continue;
      seen.add(a);
      n++;
    }
    return n;
  })();

  return (
    <div className="sp-view">
      {toolbar}

      <div className="sp-title">
        <h1>{title}</h1>
        <div className="sp-tally">
          <span className="sp-count">
            <b>{scanned.toLocaleString("en-IN")}</b>scanned this session
          </span>
          {/* Named, so "this session" is a thing the operator can point at and
              a later report can group by, rather than invisible state. */}
          <span className="sp-session" title="This batch's name">
            {session}
          </span>
          {refused > 0 && <span className="sp-pill refused">{refused} refused</span>}
          {saving > 0 && <span className="sp-pill saving">{saving} saving…</span>}
          {bad > 0 && <span className="sp-pill notsaved">{bad} NOT SAVED</span>}
          {/* Always offered, not only once there are rows: an operator who has
              just walked up to a bench someone else used needs to start clean
              BEFORE scanning, which is exactly when the list is empty. */}
          <button className="btn-ghost" onClick={newSession}>
            New session
          </button>
        </div>
      </div>

      <div
        className={
          "verdict " + verdict.cls + (listening || modal ? "" : " paused") + (verdict.awb ? "" : " no-awb")
        }
        role="status"
        aria-live="assertive"
      >
        <div className="v-label">{verdict.label}</div>
        <div className="v-awb">{verdict.awb}</div>
        <div className="v-msg">{verdict.msg}</div>
      </div>

      <div className="sp-input-wrap">
        <input
          ref={inputRef}
          className={"sp-input" + (listening || modal ? "" : " lost")}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="done"
          placeholder="Scan a barcode"
          aria-label="Scan a barcode"
          disabled={Boolean(modal)}
          onKeyDown={(e) => {
            const el = e.target as HTMLInputElement;
            if (e.key === "Enter" || (e.key === "Tab" && el.value)) {
              e.preventDefault();
              const v = el.value;
              el.value = "";
              void scan(v);
            }
          }}
          onBlur={() => setTimeout(refocus, 0)}
        />
        <button
          className={"sp-kb" + (kbOn ? " on" : "")}
          type="button"
          aria-label="Show keyboard to type an AWB"
          aria-pressed={kbOn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const next = !kbOn;
            setKbOn(next);
            if (inputRef.current) {
              inputRef.current.inputMode = next ? "text" : "none";
              inputRef.current.blur();
              inputRef.current.focus();
            }
          }}
        >
          ⌨
        </button>
      </div>

      {/* A scanner that has silently stopped listening is worse than one that
          is visibly paused, so say which it is. */}
      <div className="sp-focus-note">
        {listening || modal
          ? ""
          : document.activeElement === textRef.current
            ? "Scanner paused while you type in the paste box. Click anywhere else to resume."
            : "Scanner paused. Click anywhere on the page to resume."}
      </div>

      {/* The list's own header, with Paste list on it — the mobile layout. The
          toggle used to sit in a panel BELOW the list, so on a bench with a
          few hundred rows it was off the bottom of the screen. */}
      <div className="sp-list-head">
        <h2>This session</h2>
        <button
          className="sp-paste-link"
          aria-expanded={bulkOpen}
          onClick={() => setBulkOpen((v) => !v)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="8" y="3" width="8" height="4" rx="1" />
            <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
          </svg>
          Paste list
        </button>
      </div>

      <div className="sp-bulk" hidden={!bulkOpen}>
        <div className="sp-bulk-body">
          <textarea
            ref={textRef}
            rows={8}
            spellCheck={false}
            placeholder="One AWB per line, or separated by commas or spaces"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="sp-bulk-actions">
            <button
              className="btn-primary"
              data-busy={bulk?.running ? "true" : undefined}
              disabled={!listCount || Boolean(bulk?.running)}
              onClick={() => {
                const { list, repeated, known } = dedupe(parseList(text));
                void runBulk(list, { repeated, known });
              }}
            >
              {newCount === 0 && listCount > 0
                ? "All already recorded"
                : `Record ${newCount.toLocaleString("en-IN")} AWB${newCount === 1 ? "" : "s"}`}
            </button>
            {bulk && (
              <div className="sp-progress">
                <div className={"sp-bar" + (bulk.stopped ? " stopped" : !bulk.running ? " done" : "")}>
                  <i style={{ width: `${(bulk.done / bulk.total) * 100}%` }} />
                </div>
                <span className="sp-prog-text">
                  {bulk.done.toLocaleString("en-IN")} of {bulk.total.toLocaleString("en-IN")}
                </span>
              </div>
            )}
          </div>

          {bulk && <BulkMessage bulk={bulk} onRetry={() => void runBulk(bulk.retry)} />}

          {bulk && bulk.results.length > 0 && (
            <>
              <div className="sp-counts">
                {Object.entries(
                  // Only outcomes the SERVER returned. An attempt that never
                  // got a reply is counted under "not saved", never under the
                  // verdict we hoped for.
                  bulk.results
                    .filter((r) => ["ok", "not-found", "duplicate", "blocked"].includes(r.result))
                    .reduce<Record<string, number>>((acc, r) => {
                      acc[r.label] = (acc[r.label] || 0) + 1;
                      return acc;
                    }, {}),
                ).map(([k, n]) => (
                  <span key={k}>
                    {k} · {n}
                  </span>
                ))}
              </div>
              <div className="sp-results">
                {bulk.results.map((r, i) => (
                  <RowView
                    key={r.awb + i}
                    r={{
                      awb: r.awb,
                      time: new Date(),
                      status: (r.result === "not-found" ? "notfound" : r.result) as RowStatus,
                      order: r.order,
                      label: r.label,
                      fresh: false,
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="sp-list">
        {!rows.length ? (
          <div className="sp-empty">Scans from this session appear here, newest first.</div>
        ) : (
          <>
            <div className="sp-row head">
              <div>AWB</div>
              <div>Order</div>
              <div>Time</div>
              <div>Result</div>
            </div>
            {rows.slice(0, 200).map((r) => (
              <RowView key={r.awb} r={r} withTime onRetry={() => commit(r, false)} />
            ))}
            {rows.length > 200 && (
              <div className="sp-empty">
                Showing the latest 200 of {rows.length.toLocaleString("en-IN")}.
              </div>
            )}
          </>
        )}
      </div>


      {/* A refusal stops the bench until it is dismissed. The packet has to come
          off the pile, and a warning that clears itself would be buried by the
          next scan a second later. */}
      <div
        className="sp-modal"
        hidden={!modal}
        role="alertdialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === "Escape") closeModal();
          if (e.key === "Tab") {
            e.preventDefault();
            dismissRef.current?.focus();
          }
        }}
      >
        <div className={"sp-card " + (modal?.type || "")}>
          <div className="band">
            <div className="v-label">{modal?.label}</div>
            <div className="v-awb">{modal?.awb}</div>
          </div>
          <div className="body">
            <p>{modal?.msg}</p>
            <button ref={dismissRef} className="btn-primary dismiss" onClick={closeModal}>
              Taken off the pile — continue
            </button>
            <div className="hint">Press Enter to continue</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BulkMessage({
  bulk,
  onRetry,
}: {
  bulk: { total: number; done: number; running: boolean; stopped: boolean; retry: string[]; results: any[] };
  onRetry: () => void;
}) {
  const newly = bulk.results.filter((r) => ["ok", "not-found"].includes(r.result)).length;
  const already = bulk.results.filter((r) => r.result === "duplicate").length;
  const saved = newly + already;
  if (bulk.running) {
    return (
      <div className="sp-bulk-msg">
        Recording in chunks of 5 · {newly.toLocaleString("en-IN")} new
        {already ? `, ${already.toLocaleString("en-IN")} already scanned` : ""}.
      </div>
    );
  }
  if (bulk.stopped) {
    return (
      <div className="sp-bulk-msg err">
        Connection dropped. {saved} of {bulk.total} saved; {bulk.retry.length} still to record.{" "}
        <button className="btn-ghost" onClick={onRetry}>
          Retry the {bulk.retry.length}
        </button>
      </div>
    );
  }
  return (
    <div className="sp-bulk-msg">
      Done. {saved.toLocaleString("en-IN")} of {bulk.total.toLocaleString("en-IN")} on record
      {already ? ` — ${newly.toLocaleString("en-IN")} new, ${already.toLocaleString("en-IN")} already scanned` : ""}.
    </div>
  );
}

function RowView({ r, withTime, onRetry }: { r: Row; withTime?: boolean; onRetry?: () => void }) {
  const label = RES_LABEL[r.status] || r.label;
  const order = r.order ? (
    r.order
  ) : ["saving", "error", "duplicate", "blocked"].includes(r.status) ? (
    "—"
  ) : (
    <span className="none">not in orders</span>
  );
  return (
    <div className={`sp-row ${r.status}${r.fresh ? " fresh" : ""}`}>
      <div className="awb-cell">{r.awb}</div>
      <div className="order-cell">{order}</div>
      {withTime && <div className="time">{fmtT(r.time)}</div>}
      <div className="res-cell">
        <span className={"res " + r.status}>
          <span className="dot" />
          {label}
        </span>
        {r.status === "error" && onRetry && (
          <button className="retry" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** The big word on the verdict panel. */
function verdictLabel(d: any): string {
  if (d.result === "not-found") return "RECORDED";
  const kind = d.kind === "customer-return" ? "CUSTOMER RETURN" : d.kind === "rto" ? "RTO" : "OK";
  return d.confident === false ? `${kind} — CHECK` : kind;
}

/** The short label in the session list. */
function listLabel(d: any): string {
  if (d.result === "not-found") return "Recorded, no order";
  const kind = d.kind === "customer-return" ? "Customer return" : d.kind === "rto" ? "RTO" : "Dispatched";
  return d.confident === false ? `${kind} — check` : kind;
}

/**
 * Pull the action's payload out of a single-fetch response.
 *
 * Remix answers .data with turbo-stream: a flat array where objects hold
 * INDEXES into that array rather than values, so {"_1":2} means "key at [1],
 * value at [2]".
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
