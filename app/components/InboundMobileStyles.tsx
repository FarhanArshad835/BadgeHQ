/**
 * The mobile inbound scanner's stylesheet, lifted verbatim from the approved
 * prototype.
 *
 * A separate design from the desktop page, not a narrower copy: bottom nav for
 * thumb reach, a fixed work area above a scrolling list, and sizes tuned for a
 * rugged handheld. So it keeps its own tokens and its own font rather than
 * being translated into the claims-app system — translating a layout is how
 * "the same" becomes "nearly the same".
 *
 * Every selector is prefixed with .inbound-m, including the custom properties
 * that were on :root, so the two systems cannot reach each other. @keyframes
 * bodies are left alone: their percentage steps are not selectors.
 */
export function InboundMobileStyles() {
  return (
    <>
      {/* IBM Plex is what every size in the prototype was measured against. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
      />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </>
  );
}

const CSS = String.raw`

  .inbound-m {
    --bg: #F4F5F7; --surface: #FFFFFF; --ink: #111827; --ink-2: #374151; --muted: #4B5563;
    --line: #E5E7EB; --line-soft: #F1F2F4;
    --check: #78350F; --check-soft: #FEF3C7;
    --rto: #1E3A8A;   --rto-soft: #DBEAFE;
    --ret: #14532D;   --ret-soft: #DCFCE7;
    --sans: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;
    --pad: 12px;
    --safe-t: env(safe-area-inset-top, 0px);
    --safe-b: env(safe-area-inset-bottom, 0px);
    --safe-l: env(safe-area-inset-left, 0px);
    --safe-r: env(safe-area-inset-right, 0px);
  }
  .inbound-m * { box-sizing: border-box; }
  .inbound-m, .inbound-m { margin: 0; height: 100%; }
  .inbound-m {
    background: var(--bg); color: var(--ink); font-family: var(--sans);
    -webkit-tap-highlight-color: transparent;
    -webkit-text-size-adjust: 100%;
    overscroll-behavior: none;            /* no accidental pull-to-refresh mid-session */
  }
  .inbound-m button, .inbound-m a { touch-action: manipulation; user-select: none; -webkit-user-select: none; }
  .inbound-m button { font-family: inherit; cursor: pointer; }
  .inbound-m button:active { filter: brightness(.92); }
  .inbound-m :focus-visible { outline: 3px solid #2563EB; outline-offset: 2px; }
  .inbound-m .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* App shell: fixed top + scrolling list + bottom nav, sized to the real visible height */
  .inbound-m .app {
    height: 100vh; height: 100dvh;
    max-width: 560px; margin: 0 auto;
    display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto;
    padding-left: var(--safe-l); padding-right: var(--safe-r);
    background: var(--bg);
  }

  /* Header: session counts + menu (tabs moved to bottom for thumb reach) */
  .inbound-m .top { display: flex; align-items: center; gap: 8px;
    padding: calc(6px + var(--safe-t)) 6px 6px var(--pad); background: var(--ink); color: #fff; position: relative; }
  .inbound-m .count { display: flex; align-items: baseline; gap: 6px; }
  .inbound-m .count b { font-size: 22px; line-height: 1; }
  .inbound-m .count span { font-size: 12px; color: #CBD5E1; }
  .inbound-m .pills { flex: 1; display: flex; gap: 4px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .inbound-m .pills::-webkit-scrollbar { display: none; }
  .inbound-m .pill { font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 999px; white-space: nowrap; }
  .inbound-m .pill.rto { background: var(--rto-soft); color: var(--rto); }
  .inbound-m .pill.return { background: var(--ret-soft); color: var(--ret); }
  .inbound-m .pill.check { background: var(--check-soft); color: var(--check); }
  .inbound-m .icon-btn { width: 44px; height: 44px; border: 0; border-radius: 10px; background: transparent; color: #E5E7EB;
    display: flex; align-items: center; justify-content: center; padding: 0; flex-shrink: 0; }
  .inbound-m .menu { position: absolute; right: 6px; top: calc(54px + var(--safe-t)); z-index: 20; background: var(--surface); color: var(--ink);
    border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 10px 30px rgba(17,24,39,.2); width: min(280px, calc(100vw - 12px)); padding: 6px; }
  .inbound-m .menu[hidden] { display: none; }
  .inbound-m .menu button { width: 100%; min-height: 48px; border: 0; background: none; text-align: left; padding: 0 12px;
    font-size: 15px; border-radius: 8px; color: var(--ink); }
  .inbound-m .menu .help { padding: 8px 12px 10px; font-size: 13px; line-height: 1.45; color: var(--ink-2); border-top: 1px solid var(--line); margin-top: 4px; }
  .inbound-m .menu .help b { color: var(--ink); }

  /* Fixed working area: scan + verdict */
  .inbound-m .work { padding: 10px var(--pad) 0; display: flex; flex-direction: column; gap: 10px; }
  .inbound-m .scan { display: flex; gap: 8px; }
  .inbound-m .scan label { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 12px;
    background: var(--surface); border: 2px solid var(--ink); border-radius: 12px; }
  .inbound-m .scan input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ink);
    font-family: var(--mono); font-size: 17px; /* ≥16px stops iOS zoom-on-focus */ }
  .inbound-m .scan input::placeholder { color: #6B7280; }
  .inbound-m .sq { width: 52px; height: 52px; flex-shrink: 0; border: 1px solid #D1D5DB; border-radius: 12px; background: var(--surface);
    color: var(--ink-2); display: flex; align-items: center; justify-content: center; padding: 0; }
  .inbound-m .sq[aria-pressed="true"] { background: var(--ink); color: #fff; border-color: var(--ink); }

  .inbound-m .verdict { border-radius: 14px; overflow: hidden; background: var(--surface); border: 2px solid var(--v); }
  .inbound-m .verdict.idle { --v: #D1D5DB; border-style: dashed; }
  .inbound-m .verdict.check { --v: var(--check); }
  .inbound-m .verdict.rto { --v: var(--rto); }
  .inbound-m .verdict.return { --v: var(--ret); }
  .inbound-m .verdict.flash { animation: flash .3s ease-out; }
  @keyframes flash { from { transform: scale(.97); } to { transform: none; } }
  @media (prefers-reduced-motion: reduce) { .inbound-m .verdict.flash { animation: none; } }
  .inbound-m .idle-msg { padding: 18px 14px; font-size: 14px; color: var(--muted); text-align: center; }
  .inbound-m .v-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--v); color: #fff; }
  .inbound-m .v-head .t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .inbound-m .v-label { font-size: clamp(20px, 6.4vw, 26px); font-weight: 700; letter-spacing: .02em; line-height: 1.1; }
  .inbound-m .v-sub { font-size: 13px; font-weight: 600; opacity: .92; }
  .inbound-m .v-time { font-size: 13px; font-weight: 600; opacity: .92; align-self: flex-start; }
  .inbound-m .v-body { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; }
  .inbound-m .v-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .inbound-m .v-awb { font-family: var(--mono); font-size: clamp(17px, 5.4vw, 21px); font-weight: 600; letter-spacing: .01em; word-break: break-all; }
  .inbound-m .v-order { font-size: 14px; font-weight: 600; color: var(--muted); white-space: nowrap; }
  .inbound-m .v-reason { font-size: 14px; line-height: 1.35; color: var(--ink-2); }
  .inbound-m .v-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 0 12px 12px; }
  .inbound-m .v-actions[hidden] { display: none; }
  .inbound-m .v-actions button { min-height: 48px; border-radius: 10px; font-size: 14px; font-weight: 600; background: var(--surface); padding: 0 4px; }
  .inbound-m .a-rto { border: 1.5px solid var(--rto); color: var(--rto); }
  .inbound-m .a-ret { border: 1.5px solid var(--ret); color: var(--ret); }
  .inbound-m .a-hold { border: 0; background: var(--check) !important; color: #fff; }
  .inbound-m .undo { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px 10px; font-size: 13px; color: var(--muted); }
  .inbound-m .undo[hidden] { display: none; }
  .inbound-m .undo button { min-height: 40px; padding: 0 12px; border: 1px solid #D1D5DB; border-radius: 8px; background: var(--surface); font-size: 13px; font-weight: 600; color: var(--ink-2); }

  /* Scrolling session list */
  .inbound-m .listwrap { display: flex; flex-direction: column; min-height: 0; padding: 12px var(--pad) 8px; }
  .inbound-m .list-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .inbound-m .list-head h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--muted); }
  .inbound-m .link-btn { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 10px; border: 0; border-radius: 8px;
    background: transparent; font-size: 14px; font-weight: 600; color: var(--rto); }
  .inbound-m .paste { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .inbound-m .paste[hidden] { display: none; }
  .inbound-m .paste textarea { width: 100%; min-height: 110px; padding: 10px; border: 1px solid #D1D5DB; border-radius: 12px;
    font-family: var(--mono); font-size: 16px; resize: vertical; }
  .inbound-m .paste .row { display: flex; gap: 8px; justify-content: flex-end; }
  .inbound-m .btn { min-height: 44px; padding: 0 16px; border-radius: 10px; font-size: 14px; font-weight: 600; }
  .inbound-m .btn.ghost { border: 1px solid #D1D5DB; background: var(--surface); color: var(--ink-2); }
  .inbound-m .btn.solid { border: 0; background: var(--ink); color: #fff; }
  .inbound-m .scroller { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
    background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
  .inbound-m .list { margin: 0; padding: 0; list-style: none; }
  .inbound-m .list li { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 6px 12px; border-top: 1px solid var(--line-soft); }
  .inbound-m .list li:first-child { border-top: 0; }
  .inbound-m .tag { font-size: 11px; font-weight: 700; width: 56px; text-align: center; padding: 4px 0; border-radius: 6px; flex-shrink: 0; }
  .inbound-m .tag.rto { background: var(--rto-soft); color: var(--rto); }
  .inbound-m .tag.return { background: var(--ret-soft); color: var(--ret); }
  .inbound-m .tag.check { background: var(--check-soft); color: var(--check); }
  .inbound-m .list .m { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .inbound-m .list .awb { font-family: var(--mono); font-size: 15px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .inbound-m .list .ord, .inbound-m .list time { font-size: 12px; color: var(--muted); }
  .inbound-m .empty { padding: 20px 12px; font-size: 14px; color: var(--muted); text-align: center; }

  /* Bottom nav: reachable with the thumb while the other fingers hold the trigger */
  .inbound-m .nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--surface); border-top: 1px solid var(--line);
    padding-bottom: var(--safe-b); }
  .inbound-m .nav a { min-height: 56px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    font-size: 12px; font-weight: 500; color: var(--muted); text-decoration: none; }
  .inbound-m .nav a[aria-current="page"] { color: var(--ink); font-weight: 700; }
  .inbound-m .nav a[aria-current="page"] svg { background: var(--ink); color: #fff; border-radius: 999px; padding: 3px 14px; box-sizing: content-box; }

  /* Short screens (most rugged handhelds, or soft keyboard open): tighten */
  @media (max-height: 640px) {
    .inbound-m .work { padding-top: 8px; gap: 8px; }
    .inbound-m .scan label, .inbound-m .sq { height: 48px; }
    .inbound-m .sq { width: 48px; }
    .inbound-m .v-head, .inbound-m .v-body { padding-top: 8px; padding-bottom: 8px; }
    .inbound-m .nav a { min-height: 50px; }
    .inbound-m .nav a span { font-size: 11px; }
  }
  @media (max-height: 520px) { .inbound-m .nav { display: none; } }   /* keyboard open: give space to the work area */

  /* Very narrow (320px) */
  @media (max-width: 340px) {
    .inbound-m { --pad: 8px; }
    .inbound-m .pill { padding: 3px 6px; font-size: 11px; }
    .inbound-m .v-actions button { font-size: 13px; }
  }

  /* Landscape: work area and list side by side */
  @media (orientation: landscape) and (max-height: 560px) {
    .inbound-m .app { max-width: none; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    .inbound-m .top { grid-column: 1 / -1; }
    .inbound-m .work { overflow-y: auto; padding-bottom: 10px; }
    .inbound-m .listwrap { padding-top: 10px; }
    .inbound-m .nav { display: none; }
  }

`;
