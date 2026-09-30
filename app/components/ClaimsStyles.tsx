/**
 * The claims page's own stylesheet, lifted verbatim from the approved
 * prototype.
 *
 * Deliberately NOT rewritten in terms of the pnl-* tokens. The prototype is the
 * specification, and translating it into another design system is how "the same
 * layout" quietly becomes "nearly the same layout" — the sizes, the separators
 * and the rhythm all drift a pixel at a time.
 *
 * Every selector is prefixed with .claims-app, including the custom properties
 * that were on :root, so the two systems sit side by side and neither bleeds
 * into the other.
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
  }
  /* Sortable headers. Added on top of the prototype rather than editing its
     rules, so its own CSS stays byte-identical. The button inherits the th's
     type and colour, so a sortable header looks exactly like a static one
     until it is active. */
  .claims-app th button.sort {
    background: none; border: 0; padding: 0; margin: 0;
    font: inherit; color: inherit; cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
  }
  .claims-app th.num button.sort { flex-direction: row-reverse; }
  .claims-app th button.sort:hover { color: var(--ink); }
  .claims-app th button.sort[aria-sort="ascending"],
  .claims-app th button.sort[aria-sort="descending"] { color: var(--ink); font-weight: 500; }
  .claims-app th button.sort .arrow { opacity: 0; font-size: 10px; }
  .claims-app th button.sort:hover .arrow { opacity: .45; }
  .claims-app th button.sort[aria-sort="ascending"] .arrow,
  .claims-app th button.sort[aria-sort="descending"] .arrow { opacity: 1; }
`;
