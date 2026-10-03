/**
 * The scanner and claims stylesheet, lifted verbatim from the approved
 * prototype.
 *
 * Deliberately NOT rewritten in terms of the pnl-* tokens. The prototype is the
 * specification, and translating it into another design system is how "the same
 * layout" quietly becomes "nearly the same layout" — the sizes, the separators
 * and the rhythm all drift a pixel at a time.
 *
 * Every selector is prefixed with .claims-app, including the custom properties
 * that were on :root, so the two systems sit side by side and neither bleeds
 * into the other. @keyframes bodies are left alone: their "50%" steps are not
 * selectors and prefixing them would break the animation.
 */
export function ClaimsStyles() {
  return (
    <>
      {/* Inter is what every size in the prototype was measured against.
          Without it the page falls back to a system font and the whole scale
          shifts — the same numbers, a different-looking page. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
      />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </>
  );
}

const CSS = String.raw`

  .claims-app {
    --bg: #fafafa; --surface: #fff; --ink: #111; --muted: #8a8a8a; --soft: #a3a3a3;
    --line: #ececec; --line-strong: #dcdcdc; --green: #15803d; --amber: #d97706;
  }
  .claims-app * { box-sizing: border-box; }
  .claims-app {
    background: var(--bg); color: var(--ink);
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; -webkit-font-smoothing: antialiased;
  }
  .claims-app button, .claims-app input, .claims-app select { font: inherit; color: inherit; }
  .claims-app input:focus-visible, .claims-app select:focus-visible, .claims-app button:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
  .claims-app .wrap { max-width: 1440px; margin: 0 auto; padding: 10px 20px 28px; }

  /* Top bar */
  .claims-app .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .claims-app .nav { display: inline-flex; gap: 2px; padding: 3px; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; }
  .claims-app .nav button { border: 0; background: none; padding: 5px 13px; border-radius: 6px; cursor: pointer; color: #333; white-space: nowrap; }
  .claims-app .nav button:hover { background: #f3f3f3; }
  .claims-app .nav button.active { background: var(--ink); color: #fff; font-weight: 500; }
  .claims-app .top-right { display: flex; align-items: center; gap: 14px; color: var(--muted); min-width: 0; }
  .claims-app .today { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .claims-app .btn-ghost { background: var(--surface); border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; cursor: pointer; color: #444; white-space: nowrap; }
  .claims-app .btn-ghost:hover { border-color: var(--line-strong); }
  .claims-app .btn-ghost:disabled { opacity: .45; cursor: default; }

  /* Sub tabs */
  .claims-app .subtabs { display: flex; gap: 20px; margin-top: 14px; border-bottom: 1px solid var(--line); }
  .claims-app .subtabs button { border: 0; background: none; font-size: 14px; color: var(--muted); padding: 0 0 7px; margin-bottom: -1px; border-bottom: 2px solid transparent; cursor: pointer; }
  .claims-app .subtabs button.active { color: var(--ink); border-bottom-color: var(--ink); font-weight: 500; }

  /* Summary strip */
  .claims-app .summary { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 14px; }
  .claims-app .headline { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .claims-app .big { font-size: 30px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
  .claims-app .big-sub { color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .claims-app .stats { flex-shrink: 0; }
  .claims-app .stats { display: flex; gap: 28px; }
  .claims-app .stat .label { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .claims-app .stat .value { font-size: 18px; font-weight: 600; margin-top: 2px; white-space: nowrap; }
  .claims-app .stat .value.green { color: var(--green); }
  .claims-app .stat select { font-size: 18px; font-weight: 600; border: 0; background: transparent; padding: 0; margin-top: 2px; cursor: pointer; }

  /* Controls */
  .claims-app .controls { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .claims-app .chips { display: flex; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; flex: 0 1 auto; }
  .claims-app .chips::-webkit-scrollbar { display: none; }
  .claims-app .chip { flex-shrink: 0; }
  .claims-app .chip { height: 32px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; font-weight: 500; white-space: nowrap; }
  .claims-app .chip span { color: var(--soft); font-weight: 400; }
  .claims-app .chip:hover { border-color: var(--line-strong); }
  .claims-app .chip.active { background: var(--ink); color: #fff; border-color: var(--ink); }
  .claims-app .chip.active span { color: #bbb; }
  .claims-app .filters { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }
  .claims-app .filters input, .claims-app .filters select { height: 32px; padding: 0 9px; background: var(--surface); border: 1px solid var(--line); border-radius: 7px; }
  .claims-app .filters input { width: 200px; }
  @media (max-width: 1180px) and (min-width: 641px) {
    .claims-app .filters input { width: 150px; }
    .claims-app .today { max-width: 260px; }
  }
  .claims-app .filters select { cursor: pointer; }
  .claims-app .btn-primary { height: 32px; padding: 0 13px; background: var(--ink); color: #fff; border: 0; border-radius: 7px; cursor: pointer; font-weight: 500; white-space: nowrap; }
  .claims-app .btn-primary:hover { background: #2a2a2a; }

  /* Table */
  .claims-app .table-card { margin-top: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: auto; max-height: calc(100vh - 210px); }
  .claims-app table { width: 100%; border-collapse: collapse; min-width: 860px; }
  .claims-app th { position: sticky; top: 0; z-index: 1; background: var(--surface); text-align: left; font-weight: 400; color: var(--muted); font-size: 12px; padding: 9px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .claims-app td { padding: 7px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
  .claims-app tbody tr:last-child td { border-bottom: 0; }
  .claims-app tbody tr:hover { background: #fbfbfb; }
  .claims-app tbody tr.done { opacity: .55; }
  .claims-app th.num, .claims-app td.num { text-align: right; }
  .claims-app th:first-child, .claims-app td:first-child { width: 38px; padding-left: 14px; padding-right: 0; }
  .claims-app input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--ink); cursor: pointer; margin: 0; vertical-align: middle; }
  .claims-app .order { font-weight: 500; }
  .claims-app .awb { color: var(--muted); font-size: 11px; margin-top: 1px; letter-spacing: .02em; }
  .claims-app .unknown { color: var(--muted); }
  .claims-app .days { font-weight: 600; }
  .claims-app .cost { font-weight: 500; }
  .claims-app .sub { color: var(--muted); font-size: 11px; margin-top: 1px; }
  .claims-app .step { display: inline-flex; align-items: center; gap: 6px; color: #444; }
  .claims-app .dot { width: 6px; height: 6px; border-radius: 50%; background: #b5b5b5; flex-shrink: 0; }
  .claims-app .dot.ready { background: var(--green); } .claims-app .dot.soon { background: var(--amber); } .claims-app .dot.done { background: #2563eb; }
  .claims-app .step.ready { color: var(--green); font-weight: 500; }
  .claims-app .actions { display: flex; gap: 4px; justify-content: flex-end; }
  .claims-app .act { height: 24px; padding: 0 8px; font-size: 12px; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; cursor: pointer; color: #444; white-space: nowrap; }
  .claims-app .act:hover { border-color: var(--line-strong); }
  .claims-app .act.on { background: var(--ink); color: #fff; border-color: var(--ink); }
  .claims-app .empty { text-align: center; color: var(--muted); padding: 32px 12px; white-space: normal; }
  .claims-app .footer { display: flex; justify-content: space-between; align-items: center; padding: 8px 2px 0; color: var(--muted); font-size: 12px; }
  .claims-app .pager { display: flex; gap: 6px; }
  .claims-app .short { display: none; }

  /* Custom range popover */
  .claims-app .custom-wrap { position: relative; flex-shrink: 0; }
  .claims-app .chip .x { margin-left: 6px; color: inherit; opacity: .6; }
  .claims-app .chip .x:hover { opacity: 1; }
  .claims-app .pop {
    position: fixed; z-index: 20; width: 300px; padding: 12px;
    background: var(--surface); border: 1px solid var(--line-strong); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,.08);
  }
  .claims-app .pop[hidden] { display: none; }
  .claims-app .backdrop { display: none; }
  .claims-app .pop .title { font-weight: 600; margin-bottom: 8px; }
  .claims-app .pop .range { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .claims-app .pop label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
  .claims-app .pop input { width: 100%; height: 34px; padding: 0 8px; color-scheme: light; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); }
  .claims-app .pop .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 10px; }
  .claims-app .pop .presets button { height: 28px; padding: 0 8px; font-size: 12px; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; cursor: pointer; }
  .claims-app .pop .presets button:hover { border-color: var(--line-strong); }
  .claims-app .pop .err { color: #dc2626; font-size: 12px; margin-top: 6px; min-height: 0; }
  .claims-app .pop .row-btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }

  /* ---------- Mobile ---------- */
  @media (max-width: 640px) {
    .claims-app .wrap { padding: 8px 10px 20px; }
    .claims-app .nav { overflow-x: auto; scrollbar-width: none; min-width: 0; }
    .claims-app .nav::-webkit-scrollbar { display: none; }
    .claims-app .nav button { padding: 5px 10px; }
    .claims-app .top-right .today { display: none; }
    .claims-app .subtabs { margin-top: 10px; gap: 16px; }
    .claims-app .subtabs button { font-size: 13px; }

    .claims-app .summary { margin-top: 10px; gap: 8px; }
    .claims-app .headline { width: 100%; gap: 8px; }
    .claims-app .big { font-size: 24px; }
    .claims-app .big-sub { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .claims-app .long { display: none; } .claims-app .short { display: inline; }
    .claims-app .stats { width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; }
    .claims-app .stat .label { font-size: 11px; }
    .claims-app .stat .value, .claims-app .stat select { font-size: 15px; }

    .claims-app .controls { margin-top: 8px; gap: 6px; }
    .claims-app .chips { width: 100%; overflow-x: auto; scrollbar-width: none; margin: 0 -10px; padding: 0 10px; width: calc(100% + 20px); }
    .claims-app .chips::-webkit-scrollbar { display: none; }
    .claims-app .chip { height: 28px; padding: 0 9px; font-size: 12px; flex-shrink: 0; }
    .claims-app .filters { width: 100%; margin: 0; display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 5px; }
    .claims-app .filters input { grid-column: 1 / -1; width: 100%; }
    .claims-app .filters input, .claims-app .filters select, .claims-app .btn-primary { height: 32px; font-size: 12px; }
    .claims-app .filters select { min-width: 0; width: 100%; padding: 0 4px 0 7px; }
    .claims-app .btn-primary { padding: 0 10px; }

    /* Rows become compact cards */
    .claims-app .table-card { max-height: none; overflow: visible; }
    .claims-app table { min-width: 0; }
    .claims-app thead, .claims-app tbody, .claims-app tr, .claims-app td { display: block; }
    .claims-app thead tr { display: flex; }
    .claims-app thead th { position: static; display: none; }
    .claims-app thead th:first-child { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; }
    .claims-app thead th:first-child::after { content: "Select page"; }
    .claims-app tbody tr {
      display: grid; grid-template-columns: 22px 1fr auto; column-gap: 8px; row-gap: 3px;
      grid-template-areas: "chk order days" ". meta cost" ". step act";
      padding: 8px 10px; border-bottom: 1px solid var(--line);
    }
    .claims-app tbody tr:last-child { border-bottom: 0; }
    .claims-app td, .claims-app th:first-child, .claims-app td:first-child { padding: 0; border: 0; width: auto; white-space: normal; }
    .claims-app .c-chk { grid-area: chk; padding-top: 1px; }
    .claims-app .c-order { grid-area: order; display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .claims-app .c-order .awb { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .claims-app .c-days { grid-area: days; font-size: 14px; }
    .claims-app .c-days::after { content: "d"; font-weight: 400; color: var(--muted); margin-left: 1px; }
    .claims-app .c-carrier { grid-area: meta; font-size: 12px; color: #555; }
    .claims-app .c-carrier.unknown { color: var(--muted); }
    .claims-app .c-carrier::after { content: " · " attr(data-date); color: var(--muted); }
    .claims-app .c-date { display: none; }
    .claims-app .c-cost { grid-area: cost; font-size: 12px; }
    .claims-app .c-cost .sub { display: none; }
    .claims-app .c-step { grid-area: step; align-self: center; font-size: 12px; }
    .claims-app .c-act { grid-area: act; }
    .claims-app .act { height: 22px; padding: 0 7px; font-size: 11px; }
    .claims-app .footer { font-size: 11px; }

    /* Custom date range as a bottom sheet */
    .claims-app .backdrop { position: fixed; inset: 0; z-index: 19; background: rgba(0,0,0,.35); }
    .claims-app .backdrop:not([hidden]) { display: block; }
    .claims-app .pop {
      left: 0 !important; right: 0; top: auto !important; bottom: 0;
      width: 100%; max-height: 85vh; overflow-y: auto;
      border-radius: 14px 14px 0 0; border: 0;
      padding: 10px 16px calc(16px + env(safe-area-inset-bottom, 0px));
      box-shadow: 0 -8px 24px rgba(0,0,0,.12);
    }
    .claims-app .pop::before { content: ""; display: block; width: 36px; height: 4px; border-radius: 2px; background: var(--line-strong); margin: 0 auto 12px; }
    .claims-app .pop .title { font-size: 15px; margin-bottom: 12px; }
    .claims-app .pop .range { grid-template-columns: 1fr; gap: 10px; }
    .claims-app .pop label { font-size: 13px; }
    .claims-app .pop input { height: 44px; font-size: 16px; padding: 0 12px; }   /* 16px stops iOS zooming */
    .claims-app .pop .presets { gap: 8px; margin-top: 14px; }
    .claims-app .pop .presets button { height: 38px; font-size: 13px; }
    .claims-app .pop .err { font-size: 13px; }
    .claims-app .pop .row-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
    .claims-app .pop .row-btns button { height: 44px; font-size: 15px; }
  }

  /* =================== ScanPad (Dispatch + Inbound) =================== */
  .claims-app .sp-view { margin-top: 14px; }
  .claims-app .sp-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; margin-bottom: 12px; color: #444; }
  .claims-app .sp-toolbar b { font-variant-numeric: tabular-nums; }
  .claims-app .sp-toolbar .sub { color: var(--muted); margin-left: 6px; }

  .claims-app .sp-title { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .claims-app .sp-title h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  .claims-app .sp-tally { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
  .claims-app .sp-count { color: #555; white-space: nowrap; }
  .claims-app .sp-count b { font-size: 26px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; margin-right: 4px; }
  .claims-app .sp-pill { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .claims-app .sp-pill.refused { background: #fdf3e6; color: #8a4f07; }
  .claims-app .sp-pill.saving { background: #f1f0ee; color: #555; }
  .claims-app .sp-pill.notsaved { background: #fdecea; color: #b42318; }

  /* Verdict: slim bar when idle, compact side-by-side block when there's a result */
  .claims-app .verdict {
    margin-top: 10px; border-radius: 12px; padding: 14px 22px; background: #f1f0ee; color: #333;
    display: grid; grid-template-columns: auto 1fr; grid-template-areas: "label awb" "label msg";
    column-gap: 22px; row-gap: 2px; align-items: center; min-height: 104px; text-align: left;
    transition: background-color .12s;
  }
  .claims-app .verdict .v-label {
    grid-area: label; align-self: stretch; display: flex; align-items: center;
    font-size: 44px; font-weight: 800; letter-spacing: .03em; line-height: 1;
    padding-right: 22px; border-right: 2px solid rgba(255,255,255,.35);
  }
  .claims-app .verdict .v-awb { grid-area: awb; align-self: end; font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: .04em; line-height: 1.15; }
  .claims-app .verdict .v-msg { grid-area: msg; align-self: start; font-size: 16px; line-height: 1.4; max-width: 72ch; }
  .claims-app .verdict .v-awb:empty { display: none; }
  .claims-app .verdict.no-awb { grid-template-areas: "label msg" "label msg"; }

  .claims-app .verdict.idle {
    min-height: 0; padding: 9px 14px; grid-template-areas: "label msg"; column-gap: 12px;
    background: var(--surface); border: 1px solid var(--line);
  }
  .claims-app .verdict.idle .v-label {
    font-size: 13px; font-weight: 600; letter-spacing: 0; color: #1a7f37; border: 0; padding: 0; gap: 7px;
  }
  .claims-app .verdict.idle .v-label::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #1a7f37; animation: sp-pulse 1.6s infinite; }
  .claims-app .verdict.idle.paused .v-label { color: #8a4f07; }
  .claims-app .verdict.idle.paused .v-label::before { background: #b1660a; animation: none; }
  .claims-app .verdict.idle .v-msg { font-size: 14px; color: #555; align-self: center; }

  .claims-app .verdict.checking .v-label { font-size: 22px; color: #666; border-right-color: rgba(0,0,0,.1); }
  .claims-app .verdict.checking .v-awb { color: #555; }
  .claims-app .verdict.ok { background: #1a7f37; color: #fff; }
  .claims-app .verdict.duplicate { background: #b1660a; color: #fff; }
  .claims-app .verdict.blocked, .claims-app .verdict.error { background: #b42318; color: #fff; }
  .claims-app .verdict.notfound { background: #54308a; color: #fff; }
  .claims-app .verdict.error { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.07) 0 14px, transparent 14px 28px); }

  .claims-app .sp-input-wrap { position: relative; margin-top: 12px; }
  .claims-app .sp-input { width: 100%; height: 64px; font-size: 26px; padding: 0 60px 0 18px; border: 2px solid #3b4bc8; border-radius: 12px; background: var(--surface); font-variant-numeric: tabular-nums; letter-spacing: .03em; }
  .claims-app .sp-input:focus { outline: none; box-shadow: 0 0 0 4px rgba(59,75,200,.15); }
  .claims-app .sp-input:disabled { border-color: var(--line-strong); background: #f6f6f6; }
  .claims-app .sp-input.lost { border-color: #b1660a; }
  .claims-app .sp-focus-note { font-size: 12px; color: #8a4f07; margin-top: 4px; min-height: 16px; }
  .claims-app .sp-kb { display: none; position: absolute; right: 8px; top: 8px; height: 48px; width: 48px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); font-size: 20px; cursor: pointer; }
  .claims-app .sp-kb.on { background: var(--ink); color: #fff; }

  .claims-app .sp-list { margin-top: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .claims-app .sp-empty { padding: 14px; color: var(--muted); text-align: center; }
  .claims-app .sp-row { display: grid; grid-template-columns: minmax(150px, 1.2fr) 1.4fr 80px 170px; gap: 12px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  .claims-app .sp-row:last-child { border-bottom: 0; }
  .claims-app .sp-row.head { color: var(--muted); font-size: 12px; padding-top: 7px; padding-bottom: 7px; }
  .claims-app .sp-row.fresh { animation: sp-flash 1s ease-out; }
  @keyframes sp-flash { from { background: #fff8d6; } to { background: transparent; } }
  .claims-app .sp-row .awb-cell { font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
  .claims-app .sp-row .none { color: var(--muted); font-style: italic; }
  .claims-app .sp-row .time { color: var(--muted); font-variant-numeric: tabular-nums; }
  .claims-app .sp-row.notfound { background: #faf7fd; }
  .claims-app .sp-row.error { background: #fef6f5; }
  .claims-app .res { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; white-space: nowrap; }
  .claims-app .res .dot { width: 8px; height: 8px; }
  .claims-app .res.ok { color: #1a7f37; } .claims-app .res.ok .dot { background: #1a7f37; }
  .claims-app .res.check { color: #8a4f07; } .claims-app .res.check .dot { background: #b1660a; }
  .claims-app .res.notfound { color: #54308a; } .claims-app .res.notfound .dot { background: #54308a; }
  .claims-app .res.error { color: #b42318; } .claims-app .res.error .dot { background: #b42318; }
  .claims-app .res.saving { color: var(--muted); } .claims-app .res.saving .dot { background: #bbb; animation: sp-pulse 1s infinite; }
  .claims-app .res.duplicate { color: #8a4f07; } .claims-app .res.duplicate .dot { background: #b1660a; }
  .claims-app .res.blocked { color: #b42318; } .claims-app .res.blocked .dot { background: #b42318; }
  @keyframes sp-pulse { 50% { opacity: .3; } }
  .claims-app .retry { height: 22px; padding: 0 7px; font-size: 11px; border: 1px solid #f0c2bd; background: #fff; color: #b42318; border-radius: 6px; cursor: pointer; }

  .claims-app .sp-bulk { margin-top: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
  .claims-app .sp-bulk-toggle { width: 100%; text-align: left; border: 0; background: none; padding: 11px 14px; color: #3b4bc8; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .claims-app .sp-bulk-toggle .car { font-size: 10px; transition: transform .15s; }
  .claims-app .sp-bulk-toggle[aria-expanded="true"] .car { transform: rotate(90deg); }
  .claims-app .sp-bulk-body { padding: 0 14px 14px; }
  .claims-app .sp-bulk-body[hidden] { display: none; }
  .claims-app .sp-bulk textarea { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; padding: 10px; border: 1px solid var(--line-strong); border-radius: 8px; resize: vertical; }
  .claims-app .sp-bulk-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
  .claims-app .sp-bulk-actions .btn-primary:disabled { opacity: .45; cursor: default; }
  .claims-app .sp-progress { flex: 1; min-width: 180px; display: flex; align-items: center; gap: 10px; }
  .claims-app .sp-bar { flex: 1; height: 8px; background: #eee; border-radius: 99px; overflow: hidden; }
  .claims-app .sp-bar i { display: block; height: 100%; background: #3b4bc8; width: 0; transition: width .2s; }
  .claims-app .sp-bar.stopped i { background: #b42318; }
  .claims-app .sp-bar.done i { background: #1a7f37; }
  .claims-app .sp-prog-text { font-variant-numeric: tabular-nums; white-space: nowrap; color: #444; }
  .claims-app .sp-bulk-msg { margin-top: 8px; font-size: 13px; }
  .claims-app .sp-bulk-msg.err { color: #b42318; }
  .claims-app .sp-counts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .claims-app .sp-counts span { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #f4f4f4; font-weight: 500; }
  .claims-app .sp-results { margin-top: 8px; border: 1px solid var(--line); border-radius: 8px; max-height: 260px; overflow-y: auto; }
  .claims-app .sp-results .sp-row { grid-template-columns: minmax(150px,1.2fr) 1.4fr 170px; padding: 5px 12px; font-size: 12px; }

  .claims-app .sp-help { margin-top: 10px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; color: #555; line-height: 1.5; }

  /* Modal */
  .claims-app .sp-modal { position: fixed; inset: 0; z-index: 50; background: rgba(20,20,20,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
  .claims-app .sp-modal[hidden] { display: none; }
  .claims-app .sp-card { width: min(620px, 100%); border-radius: 16px; overflow: hidden; background: var(--surface); box-shadow: 0 20px 60px rgba(0,0,0,.3); }
  .claims-app .sp-card .band { padding: 26px 22px; text-align: center; color: #fff; }
  .claims-app .sp-card.duplicate .band { background: #b1660a; }
  .claims-app .sp-card.blocked .band { background: #b42318; }
  .claims-app .sp-card .band .v-label { font-size: 56px; font-weight: 800; letter-spacing: .04em; line-height: 1; }
  .claims-app .sp-card .band .v-awb { font-size: 30px; font-weight: 600; margin-top: 10px; font-variant-numeric: tabular-nums; letter-spacing: .04em; }
  .claims-app .sp-card .body { padding: 18px 22px 22px; text-align: center; }
  .claims-app .sp-card .body p { font-size: 17px; margin: 0 0 16px; line-height: 1.45; }
  .claims-app .sp-card .dismiss { width: 100%; height: 56px; font-size: 18px; border-radius: 10px; }
  .claims-app .sp-card .dismiss:focus-visible, .claims-app .sp-card .dismiss:focus { outline: 3px solid #3b4bc8; outline-offset: 3px; }
  .claims-app .sp-card .hint { color: var(--muted); font-size: 13px; margin-top: 8px; }

  /* Prototype switcher */
  .claims-app .proto { position: fixed; right: 12px; bottom: 12px; z-index: 40; font-size: 12px; }
  .claims-app .proto-toggle { background: #3b4bc8; color: #fff; border: 0; border-radius: 999px; padding: 7px 12px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.15); }
  .claims-app .proto-body { position: absolute; right: 0; bottom: 38px; width: 300px; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 10px; padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.12); }
  .claims-app .proto-body[hidden] { display: none; }
  .claims-app .proto-row { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .claims-app .proto-row button { height: 28px; border: 1px solid var(--line); background: var(--surface); border-radius: 6px; cursor: pointer; }
  .claims-app .proto-row button:hover { border-color: var(--line-strong); }
  .claims-app .proto-check { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .claims-app .proto-note { color: var(--muted); margin-top: 6px; }

  @media (max-width: 640px) {
    .claims-app .sp-view { margin-top: 10px; }
    .claims-app .sp-toolbar { font-size: 12px; padding: 7px 10px; }
    .claims-app .sp-toolbar .sub { display: block; margin: 0; }
    .claims-app .sp-title h1 { font-size: 17px; }
    .claims-app .sp-count b { font-size: 22px; }
    .claims-app .verdict { grid-template-columns: 1fr; grid-template-areas: "label" "awb" "msg"; text-align: center; padding: 12px; min-height: 0; margin-top: 8px; row-gap: 4px; }
    .claims-app .verdict.no-awb { grid-template-areas: "label" "msg"; }
    .claims-app .verdict .v-label { justify-content: center; font-size: 32px; border: 0; padding: 0; }
    .claims-app .verdict .v-awb { font-size: 22px; align-self: auto; }
    .claims-app .verdict .v-msg { font-size: 14px; margin: 0 auto; }
    .claims-app .verdict.idle { grid-template-columns: auto 1fr; grid-template-areas: "label msg"; text-align: left; padding: 8px 12px; }
    .claims-app .verdict.idle .v-label { font-size: 13px; }
    .claims-app .verdict.idle .v-msg { font-size: 13px; margin: 0; }
    .claims-app .verdict.checking .v-label { font-size: 18px; }
    .claims-app .sp-input { height: 56px; font-size: 20px; }
    .claims-app .sp-kb { display: block; top: 4px; }
    .claims-app .sp-row { grid-template-columns: 1fr auto; grid-template-areas: "awb res" "order time"; gap: 2px 8px; padding: 8px 10px; }
    .claims-app .sp-row.head { display: none; }
    .claims-app .sp-row .awb-cell { grid-area: awb; }
    .claims-app .sp-row .order-cell { grid-area: order; font-size: 12px; color: #555; }
    .claims-app .sp-row .time { grid-area: time; font-size: 12px; text-align: right; }
    .claims-app .sp-row .res-cell { grid-area: res; text-align: right; }
    .claims-app .sp-results .sp-row { grid-template-columns: 1fr auto; grid-template-areas: "awb res" "order order"; }
    .claims-app .sp-bulk textarea { font-size: 16px; }
    .claims-app .sp-bulk-actions .btn-primary { width: 100%; height: 44px; }
    .claims-app .sp-card .band .v-label { font-size: 40px; }
    .claims-app .sp-card .band .v-awb { font-size: 22px; }
    .claims-app .sp-card .dismiss { height: 52px; }
    .claims-app .proto-toggle { padding: 6px 10px; }
    .claims-app .proto-body { width: min(300px, calc(100vw - 24px)); }
  }
  /* The nav is <a> here, not <button>: these are real page navigations, so a
     link is the right element. The prototype's button rules are mirrored so a
     link renders identically. */
  .claims-app .nav a {
    border: 0; background: none; padding: 5px 13px; border-radius: 6px;
    cursor: pointer; color: #333; white-space: nowrap; text-decoration: none;
    font: inherit; display: inline-block;
  }
  .claims-app .nav a:hover { background: #f3f3f3; }
  .claims-app .nav a.active { background: var(--ink); color: #fff; font-weight: 500; }
  .claims-app .top-right a.btn-ghost { text-decoration: none; display: inline-block; }
  @media (max-width: 640px) {
    .claims-app .nav a { padding: 5px 10px; }
  }
  /* ---------- History ---------- */
  /* The scan count, sitting with the filters that produced it. */
  .claims-app .hist-count { align-self: center; color: #555; white-space: nowrap; }
  .claims-app .hist-count b { font-size: 18px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; margin-right: 3px; }
  .claims-app .hist-count .sub { color: var(--muted); }
  .claims-app .c-when, .claims-app .c-awb { font-variant-numeric: tabular-nums; }
  .claims-app .c-awb { font-weight: 500; }
  .claims-app .c-when { color: #555; }
  .claims-app .top-right a.btn-primary, .claims-app .filters a.btn-primary {
    text-decoration: none; display: inline-flex; align-items: center;
  }

  @media (max-width: 640px) {
    /* The same card treatment the claims table gets: a five-column row does
       not survive a phone, and a horizontal scrollbar is not an answer. */
    .claims-app .hist-count { width: 100%; }
    .claims-app .filters { grid-template-columns: 1fr 1fr auto; }
    .claims-app .table-card tbody tr {
      grid-template-columns: 1fr auto;
      grid-template-areas: "awb res" "order when";
      row-gap: 2px;
    }
    .claims-app .c-awb { grid-area: awb; }
    .claims-app .c-order { grid-area: order; font-size: 12px; color: #555; }
    .claims-app .c-when { grid-area: when; font-size: 12px; text-align: right; }
    .claims-app .c-res { grid-area: res; text-align: right; }
    .claims-app .c-kind { display: none; }
  }
  /* ---------- Scanner login ---------- */
  .claims-app.login-app { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .claims-app .login-card { width: 380px; max-width: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 22px; }
  .claims-app .login-card h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  .claims-app .login-card p { color: var(--muted); margin: 6px 0 20px; line-height: 1.5; }
  .claims-app .login-card form { display: grid; gap: 10px; }
  .claims-app .login-card input {
    height: 44px; padding: 0 12px; font-size: 16px;   /* 16px stops iOS zooming */
    background: var(--surface); border: 1px solid var(--line-strong); border-radius: 8px;
  }
  .claims-app .login-card .btn-primary { height: 44px; }
  .claims-app .login-err { color: #b42318; font-size: 13px; }
  /* History's filter row carries a search box as well as the two selects, so
     the search spans the full width on a phone rather than being squeezed. */
  @media (max-width: 640px) {
    .claims-app .filters { grid-template-columns: 1fr 1fr auto; }
    .claims-app .filters input[type="search"] { grid-column: 1 / -1; width: 100%; }
  }
  /* History carries more filters than claims: a search box, a date range, two
     date inputs and two selects. They wrap rather than squeeze. */
  .claims-app .filters { flex-wrap: wrap; }
  .claims-app .filters input[type="date"] {
    height: 32px; padding: 0 9px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 7px; color-scheme: light;
  }
  @media (max-width: 640px) {
    .claims-app .filters { grid-template-columns: 1fr 1fr; }
    .claims-app .filters input[type="search"] { grid-column: 1 / -1; }
    .claims-app .filters a.btn-primary { grid-column: 1 / -1; justify-content: center; }
  }
  /* ---------- Press feedback ---------- */
  /* Every control answered a tap with nothing: no press state, no cursor
     change, no busy state. On a bench that reads as a broken button, and the
     operator presses again. */
  .claims-app button, .claims-app .btn-primary, .claims-app .btn-ghost,
  .claims-app .chip, .claims-app .act, .claims-app .sp-bulk-toggle {
    transition: transform 60ms ease, filter 60ms ease, opacity 60ms ease;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  .claims-app button:not(:disabled):active,
  .claims-app .btn-primary:not(:disabled):active,
  .claims-app .btn-ghost:not(:disabled):active,
  .claims-app .chip:active, .claims-app .act:active {
    transform: translateY(1px) scale(0.985);
    filter: brightness(0.93);
  }
  .claims-app button:disabled { cursor: default; opacity: .5; }
  .claims-app a.btn-primary:active, .claims-app a.btn-ghost:active {
    transform: translateY(1px) scale(0.985); filter: brightness(0.93);
  }

  /* A control doing work says so, rather than looking merely disabled. */
  .claims-app .btn-primary[data-busy="true"] {
    position: relative; color: transparent;
  }
  .claims-app .btn-primary[data-busy="true"]::after {
    content: ""; position: absolute; inset: 0; margin: auto;
    width: 15px; height: 15px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
    animation: sp-spin .6s linear infinite;
  }
  @keyframes sp-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .claims-app .btn-primary[data-busy="true"]::after { animation: none; }
    .claims-app button:active { transform: none; }
  }
  /* The session's name, beside the tally it belongs to. Quiet: it identifies
     the batch rather than competing with the count. */
  .claims-app .sp-session {
    font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums;
    padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px;
    white-space: nowrap;
  }
  /* ---------- Session list header ---------- */
  /* Paste list sits on the header row with the list, as the mobile layout has
     it. It used to be a panel BELOW the list, which on a bench with a few
     hundred rows put it off the bottom of the screen. */
  .claims-app .sp-list-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; margin: 14px 0 6px;
  }
  .claims-app .sp-list-head h2 {
    margin: 0; font-size: 14px; font-weight: 600; color: var(--muted);
  }
  .claims-app .sp-paste-link {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 36px; padding: 0 10px; border: 0; border-radius: 8px;
    background: transparent; font: inherit; font-size: 14px; font-weight: 600;
    color: #3b4bc8; cursor: pointer;
  }
  .claims-app .sp-paste-link:hover { background: #f3f3f3; }
  .claims-app .sp-paste-link[aria-expanded="true"] { background: #eef0fb; }

  /* The panel no longer carries its own toggle, so it needs the border the
     toggle used to sit inside. */
  .claims-app .sp-bulk[hidden] { display: none; }
  .claims-app .sp-bulk .sp-bulk-body { padding: 14px; }
  /* ---------- Title row ---------- */
  /* The tally gained a session name and a permanent New session button, which
     pushed a row that already wrapped onto three lines. Rebuilt as a two-column
     grid so the title holds the left and everything else stacks on the right in
     a fixed order, instead of wrapping wherever it runs out of room. */
  .claims-app .sp-title {
    display: grid; grid-template-columns: 1fr auto; align-items: center;
    gap: 4px 14px; flex-wrap: nowrap;
  }
  /* The count and New session are anchored; the pills between them wrap when
     all three appear at once, which at 420px would otherwise overflow the row
     by ~190px. Anchoring everything would have pushed the button off-screen —
     worse than a second line of pills. */
  .claims-app .sp-tally {
    grid-column: 2; justify-content: flex-end; align-items: center;
    flex-wrap: wrap; gap: 6px 10px; row-gap: 6px;
  }
  .claims-app .sp-tally .sp-count,
  .claims-app .sp-tally > .btn-ghost { flex-shrink: 0; }
  .claims-app .sp-pill { flex-shrink: 1; min-width: 0; }
  /* The count and its session name read as one unit and never split. */
  .claims-app .sp-count { display: inline-flex; align-items: baseline; gap: 5px; }

  /* Anchored at every width: title hard left, tally hard right, one line. The
     row shrinks rather than stacking, so a control never moves to a different
     place on a narrower screen — an operator reaches for New session in the
     same spot on a phone as on the bench terminal. */
  .claims-app .sp-title h1 {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }


  @media (max-width: 720px) {
    /* Sizes come down, positions do not. */
    .claims-app .sp-title { gap: 4px 8px; }
    .claims-app .sp-tally { gap: 6px; }
    .claims-app .sp-count b { font-size: 20px; }
    .claims-app .sp-count { font-size: 12px; }
    .claims-app .sp-session { font-size: 11px; padding: 2px 6px; }
  }
  @media (max-width: 420px) {
    .claims-app .sp-title h1 { font-size: 15px; }
    .claims-app .sp-count b { font-size: 18px; }
    /* "scanned this session" is the first thing to go: the big number and the
       button it sits beside carry the meaning on their own. */
    .claims-app .sp-count .sp-count-label { display: none; }
    /* The session name STAYS. It is the one piece of state an operator cannot
       work out from anything else on screen — which batch they are scanning
       into — so it survives every width. It loses its border rather than its
       presence. */
    .claims-app .sp-session {
      border-color: transparent; padding: 2px 0; font-size: 11px;
    }
  }
  /* ---------- Sign out ---------- */
  /* On the bar at desk width; at the foot of the page on a phone, where the
     bar carries the four links alone. */
  .claims-app .sign-out-foot { display: none; }

  @media (max-width: 640px) {
    .claims-app .top-right .sign-out { display: none; }
    /* The whole right-hand group is empty on a phone now, so it takes no space
       away from the four links. */
    .claims-app .top-right { display: none; }
    .claims-app .nav { width: 100%; }
    /* Rendered right after the nav, so in document order it sits at the TOP —
       which looked like a stray button under the tabs. Taken out of flow and
       pinned to the bottom corner instead: reachable, and nowhere near the
       tabs or the scan field. */
    .claims-app .sign-out-foot {
      display: block; position: fixed;
      right: 10px; bottom: calc(10px + env(safe-area-inset-bottom, 0px));
      z-index: 30;
      padding: 7px 14px; font-size: 12px; font-weight: 600; color: var(--muted);
      border: 1px solid var(--line-strong); border-radius: 999px;
      background: var(--surface); text-decoration: none;
      box-shadow: 0 2px 10px rgba(17,24,39,.08);
    }
    .claims-app .sign-out-foot:active { filter: brightness(.95); }
    /* Room beneath the content so the pinned button never covers the last row
       of a list someone has scrolled to the end of. */
    .claims-app .wrap { padding-bottom: 64px; }
  }
`;
