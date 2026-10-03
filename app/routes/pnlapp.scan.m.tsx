/**
 * Inbound scanner, mobile. Built to the approved prototype.
 *
 * Same grid, elements, padding, type scale and visual flow: a fixed work area
 * above a scrolling session list, bottom nav for thumb reach while the other
 * fingers hold the trigger, and sizes tuned for a rugged handheld rather than a
 * desk.
 *
 * It is a different design from the desktop page, not a narrower copy, so it
 * keeps the prototype's own stylesheet and font verbatim.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import {
  loadScannedSet,
  recordScan,
  resolveScan,
  scanCountsToday,
  type ScanKind,
} from "../utils/scan.server";
import { InboundMobileStyles } from "../components/InboundMobileStyles";
import { BusyBar } from "../components/BusyBar";

/**
 * The prototype's viewport, which the app's default does not cover.
 *
 * viewport-fit=cover is what makes env(safe-area-inset-*) report real values,
 * so the header clears a notch and the bottom nav clears the home indicator.
 * Without it those insets are 0 and the nav sits under the gesture bar.
 *
 * interactive-widget=resizes-content keeps the soft keyboard from covering the
 * scan field: the layout shrinks instead of being pushed off-screen. Rendered
 * after root's tag, so this one wins.
 */
export const meta = () => [
  { title: "Inbound – JM Looks Ops" },
  {
    name: "viewport",
    content:
      "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
  },
  { name: "theme-color", content: "#111827" },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
  // A long AWB should never become a tap-to-call link.
  { name: "format-detection", content: "telephone=no" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  const [counts, rto, cr] = await Promise.all([
    shop ? scanCountsToday(shop) : Promise.resolve({}),
    shop ? loadScannedSet(shop, "rto") : Promise.resolve([]),
    shop ? loadScannedSet(shop, "customer-return") : Promise.resolve([]),
  ]);
  return json({ counts, alreadyScanned: [...rto, ...cr] });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request, "scan")) return json({ error: "unauthorized" }, { status: 401 });
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ error: "not-configured" }, { status: 400 });

  const body = await request.json().catch(() => null);

  // Filing a CHECK by hand: the operator has decided what the data could not.
  if (body?.resolve) {
    await resolveScan(
      shop,
      String(body.awb || ""),
      (body.from || "rto") as ScanKind,
      body.resolve === "hold" ? "hold" : (body.resolve as ScanKind),
      String(body.orderName || ""),
    );
    return json({ ok: true });
  }

  if (!body?.awb) return json({ error: "bad-request" }, { status: 400 });
  return json(
    await recordScan(shop, "inbound", String(body.awb), { session: String(body.session || "") }),
  );
};

type Verdict = "rto" | "return" | "check" | "hold";

type Item = {
  verdict: Verdict;
  awb: string;
  order: string;
  reason: string;
  time: string;
  /** What the scan was actually filed as, so a later resolve can move it. */
  kind: ScanKind;
};

const META: Record<string, { label: string; tag: string; sub: string; icon: JSX.Element }> = {
  check: {
    label: "CHECK",
    tag: "CHECK",
    sub: "Could not classify — do not file yet",
    icon: (
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3 2 20h20L12 3z" />
        <path d="M12 10v4M12 17h.01" />
      </svg>
    ),
  },
  rto: {
    label: "RTO",
    tag: "RTO",
    sub: "Courier returned undelivered",
    icon: (
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
      </svg>
    ),
  },
  return: {
    label: "CUSTOMER RETURN",
    tag: "RETURN",
    sub: "ReturnHQ request matched",
    icon: (
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 3 3 5-6" />
      </svg>
    ),
  },
  hold: { label: "ON HOLD", tag: "HOLD", sub: "Kept aside for review", icon: <></> },
};

const STORE = "jm-inbound-session";
const hhmm = (d: Date) => d.toTimeString().slice(0, 5);

export default function InboundMobile() {
  const d = useLoaderData<typeof loader>();
  const scanRef = useRef<HTMLInputElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [current, setCurrent] = useState<Item | null>(null);
  const [lastResolve, setLastResolve] = useState<{ awb: string; prev: Item } | null>(null);
  const [sound, setSound] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [kbd, setKbd] = useState(false);
  // Named like the desktop scanners, so a batch started on a phone is the same
  // kind of thing and shows up in the same lists.
  const [session] = useState(() => {
    const d = new Date();
    const mon = d.toLocaleDateString("en-GB", { month: "short" });
    return `${d.getDate()} ${mon} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [flash, setFlash] = useState(0);

  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  // Preloaded, so a parcel booked in on an earlier session is known without
  // asking the server.
  const scannedSet = useRef<Set<string>>(new Set());
  useEffect(() => {
    scannedSet.current = new Set(d.alreadyScanned || []);
  }, [d.alreadyScanned]);

  /* The session survives a reload or the tab being killed in the background. */
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || "null");
      if (s) {
        setItems(s.items || []);
        setSound(s.sound !== false);
      }
    } catch {
      /* a corrupt or unavailable store just means an empty session */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ items, sound }));
    } catch {
      /* private mode, quota: not worth failing a scan over */
    }
  }, [items, sound]);

  /* Beep and vibrate, so the operator need not look at the screen for every
     parcel. Vibration carries through a glove and a noisy floor. */
  const actx = useRef<AudioContext | null>(null);
  const beep = useCallback(
    (kind: "ok" | "check" | "error") => {
      if (navigator.vibrate) {
        navigator.vibrate(kind === "check" ? [90, 60, 90] : kind === "error" ? [200] : 40);
      }
      if (!sound) return;
      try {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        actx.current = actx.current || new Ctx();
        const tones = kind === "check" ? [520, 390] : kind === "error" ? [220] : [1040];
        tones.forEach((f, i) => {
          const o = actx.current!.createOscillator();
          const g = actx.current!.createGain();
          o.frequency.value = f;
          o.type = "square";
          g.gain.value = 0.06;
          o.connect(g);
          g.connect(actx.current!.destination);
          const t = actx.current!.currentTime + i * 0.14;
          o.start(t);
          o.stop(t + 0.1);
        });
      } catch {
        /* audio is a nicety; never let it break a scan */
      }
    },
    [sound],
  );

  /* Stop the screen sleeping mid-session. */
  const wakeLock = useRef<any>(null);
  const keepAwake = useCallback(async () => {
    try {
      if ("wakeLock" in navigator && !wakeLock.current) {
        wakeLock.current = await (navigator as any).wakeLock.request("screen");
        wakeLock.current.addEventListener("release", () => (wakeLock.current = null));
      }
    } catch {
      /* unsupported, or denied in the background */
    }
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void keepAwake();
        scanRef.current?.focus();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    void keepAwake();
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [keepAwake]);

  /* The next trigger pull must always land in the scan field. */
  useEffect(() => {
    const onUp = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("textarea, .menu, #menuBtn, a, button")) return;
      setTimeout(() => scanRef.current?.focus({ preventScroll: true }), 0);
    };
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".menu, #menuBtn")) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  async function handleAwb(raw: string) {
    const awb = String(raw).trim().replace(/\s+/g, "");
    if (!awb) return;
    void keepAwake();

    const dup = itemsRef.current.find((i) => i.awb === awb);
    if (dup) {
      setCurrent({ ...dup, reason: `Already scanned at ${dup.time}. ${dup.reason}` });
      setLastResolve(null);
      setFlash((n) => n + 1);
      beep("check");
      return;
    }

    try {
      const res = await fetch(window.location.pathname + ".data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ awb, session }),
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = decodeTurboStream(await res.text());

      // Green means written. Only these four mean the server dealt with it.
      const WROTE = ["ok", "not-found", "duplicate", "blocked"];
      if (!data || data.error || !WROTE.includes(data.result)) {
        throw new Error(String(data?.error || data?.result || "no-result"));
      }

      // CHECK covers everything the data could not settle, not just a
      // low-confidence guess:
      //   not-found  nothing anywhere knows this AWB
      //   duplicate  already on record, so this scan decided nothing
      // Showing either as a confident RTO would put a parcel in a bucket on
      // the strength of a default.
      const verdict: Verdict =
        data.result !== "ok" || data.confident === false
          ? "check"
          : data.kind === "customer-return"
            ? "return"
            : "rto";
      const item: Item = {
        verdict,
        awb,
        order: data.orderName || "",
        reason: data.message || "",
        time: hhmm(new Date()),
        kind: (data.kind || "rto") as ScanKind,
      };
      setItems((prev) => [item, ...prev]);
      setCurrent(item);
      setLastResolve(null);
      setFlash((n) => n + 1);
      beep(verdict === "check" ? "check" : "ok");
    } catch {
      setCurrent({
        verdict: "check",
        awb,
        order: "",
        reason: "Lookup failed. Check the connection and scan again.",
        time: hhmm(new Date()),
        kind: "rto",
      });
      setLastResolve(null);
      setFlash((n) => n + 1);
      beep("error");
    }
  }

  async function resolve(action: "rto" | "return" | "hold") {
    if (!current) return;
    const prev = { ...current };
    try {
      const res = await fetch(window.location.pathname + ".data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolve: action,
          awb: current.awb,
          from: current.kind,
          orderName: current.order,
        }),
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      beep("error");
      return;
    }
    const kind: ScanKind = action === "return" ? "customer-return" : "rto";
    const next: Item = {
      ...current,
      verdict: action,
      kind: action === "hold" ? current.kind : kind,
      reason: action === "hold" ? "Marked for review." : "Filed by hand from CHECK.",
    };
    setItems((prev2) => prev2.map((i) => (i.awb === current.awb ? next : i)));
    setCurrent(next);
    setLastResolve({ awb: current.awb, prev });
    setFlash((n) => n + 1);
    beep("ok");
  }

  async function undo() {
    if (!lastResolve) return;
    const { awb, prev } = lastResolve;
    try {
      const res = await fetch(window.location.pathname + ".data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolve: prev.kind, awb, from: current?.kind || prev.kind }),
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      beep("error");
      return;
    }
    setItems((prev2) => prev2.map((i) => (i.awb === awb ? prev : i)));
    setCurrent(prev);
    setLastResolve(null);
  }

  const total = items.length;
  const cRto = items.filter((i) => i.verdict === "rto").length;
  const cRet = items.filter((i) => i.verdict === "return").length;
  const cChk = items.filter((i) => i.verdict === "check" || i.verdict === "hold").length;
  const v = current ? (current.verdict === "hold" ? "check" : current.verdict) : "idle";
  const meta = current ? META[current.verdict] : null;

  return (
    <div className="inbound-m">
      <InboundMobileStyles />
      <BusyBar />
      <div className="app">
        <header className="top">
          <div className="count" aria-label="Scanned this session">
            <b>{total}</b>
            <span>scanned</span>
          </div>
          <div className="pills">
            <span className="pill rto">RTO <span>{cRto}</span></span>
            <span className="pill return">Ret <span>{cRet}</span></span>
            <span className="pill check">Check <span>{cChk}</span></span>
          </div>
          <button
            className="icon-btn"
            id="menuBtn"
            aria-label="More options"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <circle cx="12" cy="5" r=".6" />
              <circle cx="12" cy="12" r=".6" />
              <circle cx="12" cy="19" r=".6" />
            </svg>
          </button>
          <div className="menu" hidden={!menuOpen}>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                if (items.length && !confirm("Start a new session? This list will be cleared.")) return;
                setItems([]);
                setCurrent(null);
                setLastResolve(null);
              }}
            >
              New session
            </button>
            <button type="button" aria-pressed={sound} onClick={() => setSound((s) => !s)}>
              Sound: {sound ? "on" : "off"}
            </button>
            <a
              href="/pnl-app/scan/logout"
              style={{ display: "block", minHeight: 48, lineHeight: "48px", padding: "0 12px", fontSize: 15, color: "inherit", textDecoration: "none" }}
            >
              Sign out
            </a>
          </div>
        </header>

        <section className="work">
          <div className="scan">
            <label>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
                <path d="M7 8v8M10 8v8M13 8v8M17 8v8" />
              </svg>
              <span className="sr-only">Scan a barcode</span>
              <input
                ref={scanRef}
                inputMode={kbd ? "numeric" : "none"}
                enterKeyHint="go"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Scan or type AWB"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== "Tab") return;
                  e.preventDefault();
                  if (idleTimer.current) clearTimeout(idleTimer.current);
                  const el = e.target as HTMLInputElement;
                  const val = el.value;
                  el.value = "";
                  void handleAwb(val);
                }}
                onChange={(e) => {
                  // Some guns send no Enter at all, so a pause in the typing is
                  // treated as the end of a code — but only when the keyboard
                  // is off, or a person typing by hand would fire early.
                  if (idleTimer.current) clearTimeout(idleTimer.current);
                  if (kbd) return;
                  const el = e.target as HTMLInputElement;
                  idleTimer.current = setTimeout(() => {
                    if (el.value.trim().length >= 8) {
                      const val = el.value;
                      el.value = "";
                      void handleAwb(val);
                    }
                  }, 120);
                }}
              />
            </label>
            <button
              className="sq"
              type="button"
              aria-label={kbd ? "Hide keyboard" : "Show keyboard"}
              aria-pressed={kbd}
              onClick={() => {
                setKbd((k) => !k);
                scanRef.current?.blur();
                setTimeout(() => scanRef.current?.focus(), 30);
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
              </svg>
            </button>
          </div>

          <section className={`verdict ${v} flash`} key={flash} aria-live="assertive">
            {!current ? (
              <div className="idle-msg">Ready. Scan a parcel.</div>
            ) : (
              <div>
                <div className="v-head">
                  <span aria-hidden="true">{meta?.icon}</span>
                  <div className="t">
                    <span className="v-label">{meta?.label}</span>
                    <span className="v-sub">{meta?.sub}</span>
                  </div>
                  <span className="v-time">{current.time}</span>
                </div>
                <div className="v-body">
                  <div className="v-row">
                    <span className="v-awb">{current.awb}</span>
                    <span className="v-order">{current.order}</span>
                  </div>
                  <span className="v-reason">{current.reason}</span>
                </div>
                <div className="v-actions" hidden={current.verdict !== "check"}>
                  <button className="a-rto" type="button" onClick={() => void resolve("rto")}>
                    File RTO
                  </button>
                  <button className="a-ret" type="button" onClick={() => void resolve("return")}>
                    File return
                  </button>
                  <button className="a-hold" type="button" onClick={() => void resolve("hold")}>
                    Hold
                  </button>
                </div>
                <div className="undo" hidden={!lastResolve || lastResolve.awb !== current.awb}>
                  <span>
                    {current.verdict === "hold"
                      ? "Put on hold."
                      : `Filed as ${META[current.verdict]?.tag}.`}
                  </span>
                  <button type="button" onClick={() => void undo()}>
                    Undo
                  </button>
                </div>
              </div>
            )}
          </section>
        </section>

        <section className="listwrap">
          <div className="list-head">
            <h2>This session</h2>
            <button
              className="link-btn"
              type="button"
              aria-expanded={pasteOpen}
              onClick={() => setPasteOpen((o) => !o)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="8" y="3" width="8" height="4" rx="1" />
                <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
              </svg>
              Paste list
            </button>
          </div>
          <div className="paste" hidden={!pasteOpen}>
            <label className="sr-only" htmlFor="pasteArea">
              AWB numbers, one per line
            </label>
            <textarea
              id="pasteArea"
              inputMode="numeric"
              placeholder="One AWB per line"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="row">
              <button className="btn ghost" type="button" onClick={() => setPasteOpen(false)}>
                Cancel
              </button>
              <button
                className="btn solid"
                type="button"
                onClick={async () => {
                  // Repeats and parcels an earlier session already booked in are
                  // dropped here: each would otherwise cost a request to be told
                  // what we already know.
                  const seen = new Set<string>();
                  const list = pasteText
                    .split(/[\s,;]+/)
                    .filter(Boolean)
                    .filter((a) => {
                      if (seen.has(a) || scannedSet.current.has(a)) return false;
                      seen.add(a);
                      return true;
                    });
                  setPasteOpen(false);
                  setPasteText("");
                  for (const a of list) await handleAwb(a);
                }}
              >
                Check all
              </button>
            </div>
          </div>
          <div className="scroller">
            <ul className="list">
              {!items.length ? (
                <li className="empty">Nothing scanned yet.</li>
              ) : (
                items.map((it, i) => (
                  <li key={it.awb + i}>
                    <span className={`tag ${it.verdict === "hold" ? "check" : it.verdict}`}>
                      {META[it.verdict]?.tag}
                    </span>
                    <div className="m">
                      <span className="awb">{it.awb}</span>
                      <span className="ord">{it.order}</span>
                    </div>
                    <time>{it.time}</time>
                  </li>
                ))
              )}
            </ul>
          </div>
        </section>

        <nav className="nav" aria-label="Sections">
          <a href="/pnl-app/scan/dispatch">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7h11v10H3zM14 10h4l3 3v4h-7" />
              <circle cx="7" cy="18" r="1.6" />
              <circle cx="17" cy="18" r="1.6" />
            </svg>
            <span>Dispatch</span>
          </a>
          <a href="/pnl-app/scan/m" aria-current="page">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
              <path d="M12 13V21M3 8l9 5 9-5" />
            </svg>
            <span>Inbound</span>
          </a>
          <a href="/pnl-app/scan/claims">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <path d="M14 3v6h6M9 14h6M9 17h4" />
            </svg>
            <span>Claims</span>
          </a>
          <a href="/pnl-app/scan/history">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>History</span>
          </a>
        </nav>
      </div>
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
