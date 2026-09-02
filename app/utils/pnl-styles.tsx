/**
 * Shared visual system for the standalone P&L tool (/pnl-app). Inline styles
 * can't express :hover/:focus/:active, so the interaction states live in this
 * one <style> block, injected once per page via <PnlStyles/>. Tokens are OKLCH,
 * neutrals tinted toward the indigo ink, money-positive/negative are muted and
 * meaningful (not decorative). Motion is ease-out, and honours reduced-motion.
 */

export const CSS = `
:root {
  color-scheme: light; /* always light — keep native controls (selects, inputs) light regardless of OS theme */
  --ink:        oklch(0.28 0.03 275);
  --ink-soft:   oklch(0.48 0.02 275);
  --ink-faint:  oklch(0.62 0.015 275);
  --line:       oklch(0.91 0.006 275);
  --line-soft:  oklch(0.95 0.005 275);
  --surface:    oklch(0.995 0.002 275);
  --panel:      oklch(1 0 0);
  --bg:         oklch(0.975 0.004 275);
  --accent:     oklch(0.52 0.15 275);
  --accent-ink: oklch(0.42 0.16 275);
  --accent-wash:oklch(0.96 0.02 275);
  --pos:        oklch(0.52 0.11 155);
  --neg:        oklch(0.55 0.13 35);
  --warn-bg:    oklch(0.97 0.03 75);
  --warn-line:  oklch(0.88 0.07 75);
  --ok-bg:      oklch(0.96 0.05 155);
  --shadow:     0 1px 1px oklch(0.28 0.03 275 / 0.04);
  --radius:     6px;
  --ease:       cubic-bezier(0.22, 1, 0.36, 1);
}

.pnl {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding: 18px 20px 40px;
  font-size: 13px;
}
/* Use the width the screen actually has: the old 940px cap left most of a
   desktop monitor empty. Capped generously so text lines stay readable. */
.pnl-wrap { max-width: 1600px; margin: 0 auto; }
.pnl-wrap.narrow { max-width: 460px; }

.pnl-h1 { margin: 0; font-size: 19px; font-weight: 680; letter-spacing: -0.02em; }
.pnl-sub { color: var(--ink-soft); font-size: 12.5px; line-height: 1.5; }

/* header row */
.pnl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 14px; }
.pnl-headlinks { display: flex; gap: 14px; align-items: center; }

/* text link */
.pnl-link {
  color: var(--accent-ink); text-decoration: none; font-size: 13px; font-weight: 550;
  padding: 4px 2px; border-radius: 6px; position: relative;
  transition: color 140ms var(--ease);
}
.pnl-link::after {
  content: ""; position: absolute; left: 2px; right: 2px; bottom: 1px; height: 1.5px;
  background: currentColor; transform: scaleX(0); transform-origin: left;
  transition: transform 180ms var(--ease);
}
.pnl-link:hover::after { transform: scaleX(1); }
.pnl-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* buttons */
/* Secondary is the DEFAULT button: it needs a real resting surface and its own
   hover/active, or every non-primary action reads as dead text. */
.pnl-btn {
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  padding: 6px 12px; border-radius: 5px;
  background: var(--panel); color: var(--ink); border: 1px solid var(--line);
  transition: transform 120ms var(--ease), box-shadow 160ms var(--ease),
              background 140ms var(--ease), border-color 140ms var(--ease), opacity 120ms var(--ease);
}
.pnl-btn:hover:not(:disabled) { background: var(--surface); border-color: var(--ink-faint); }
.pnl-btn:active:not(:disabled) { transform: translateY(1px); background: var(--accent-wash); border-color: var(--accent); box-shadow: none; }
.pnl-btn-primary { background: var(--ink); color: oklch(0.99 0.003 275); border-color: transparent; }
.pnl-btn-primary:hover:not(:disabled) { background: var(--accent-ink); border-color: transparent; }
.pnl-btn-primary:active:not(:disabled) { transform: translateY(1px); background: var(--accent-ink); box-shadow: none; }
.pnl-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pnl-btn:disabled { opacity: 0.6; cursor: default; }
.pnl-btn-primary:disabled { opacity: 1; } /* stays solid while syncing so the count reads clearly */
.pnl-btn-busy { display: inline-flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
.pnl-spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid oklch(0.99 0.003 275 / 0.35);
  border-top-color: oklch(0.99 0.003 275);
  animation: pnl-spin 0.7s linear infinite;
}
@keyframes pnl-spin { to { transform: rotate(360deg); } }

/* select */
.pnl-select {
  font: inherit; font-size: 13px; color: var(--ink); background: var(--panel);
  padding: 6px 26px 6px 9px; border: 1px solid var(--line); border-radius: 5px;
  cursor: pointer; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%236b6b80' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  transition: border-color 140ms var(--ease), box-shadow 140ms var(--ease);
}
.pnl-select:hover { border-color: var(--ink-faint); }
.pnl-select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-wash); }
.pnl-select:active { border-color: var(--accent); }

/* text input */
.pnl-input {
  font: inherit; font-size: 13px; color: var(--ink); background: var(--panel);
  width: 100%; box-sizing: border-box;
  padding: 6px 9px; border: 1px solid var(--line); border-radius: 5px;
  transition: border-color 140ms var(--ease), box-shadow 140ms var(--ease);
}
.pnl-input::placeholder { color: var(--ink-faint); }
.pnl-input:hover { border-color: var(--ink-faint); }
.pnl-input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-wash); }

/* tabs */
.pnl-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 14px; }
.pnl-tab {
  font: inherit; font-size: 13px; font-weight: 550; cursor: pointer;
  background: none; border: none; color: var(--ink-soft);
  padding: 7px 12px; position: relative;
  transition: color 140ms var(--ease);
}
.pnl-tab::after {
  content: ""; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px;
  background: var(--ink); border-radius: 2px 2px 0 0;
  transform: scaleX(0); transition: transform 200ms var(--ease);
}
.pnl-tab:hover { color: var(--ink); }
.pnl-tab:active { color: var(--accent-ink); }
.pnl-tab[data-active="true"] { color: var(--ink); font-weight: 640; }
.pnl-tab[data-active="true"]::after { transform: scaleX(1); }
.pnl-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }

/* banner */
.pnl-banner { padding: 8px 11px; border-radius: 5px; font-size: 12.5px; line-height: 1.45; border: 1px solid transparent; }
.pnl-banner.info { background: var(--surface); border-color: var(--line); color: var(--ink-soft); }
.pnl-banner.ok   { background: var(--ok-bg); border-color: oklch(0.86 0.07 155); color: oklch(0.34 0.09 155); }
.pnl-banner.warn { background: var(--warn-bg); border-color: var(--warn-line); color: oklch(0.42 0.09 75); }
.pnl-banner.bad  { background: oklch(0.96 0.04 35); border-color: oklch(0.86 0.08 35); color: oklch(0.42 0.12 35); }

/* KPI tiles */
.pnl-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 9px; margin-bottom: 10px; }
.pnl-kpi {
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 10px 12px;
  transition: border-color 160ms var(--ease);
}
.pnl-kpi:hover { border-color: var(--line); }
.pnl-kpi-label { font-size: 11px; color: var(--ink-faint); margin-bottom: 3px; letter-spacing: 0.01em; }
.pnl-kpi-value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.pnl-kpi-value.neg { color: var(--neg); }
.pnl-kpi.headline, .pnl-kpi.accent { background: var(--accent-wash); border-color: oklch(0.88 0.04 275); }
.pnl-kpi.headline .pnl-kpi-value, .pnl-kpi.accent .pnl-kpi-value { color: var(--accent-ink); }
.pnl-kpi-sub { font-size: 11px; color: var(--ink-faint); margin-top: 3px; }

/* Monthly-P&L waterfall + two-up panels */
.pnl-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 720px) { .pnl-grid2 { grid-template-columns: 1fr; } }

/* Wide-screen main layout: the statement sits beside the funnel/per-unit panels
   instead of each stretching the full width with a lone figure on the right. */
.pnl-main { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 10px; align-items: start; }
@media (max-width: 1100px) { .pnl-main { grid-template-columns: 1fr; } }
.pnl-main .pnl-grid2 { grid-template-columns: 1fr; }
@media (min-width: 1400px) { .pnl-main .pnl-grid2 { grid-template-columns: 1fr 1fr; } }
.pnl-waterfall td:first-child { color: var(--ink-soft); }
.pnl-waterfall .pnl-strong td, .pnl-waterfall td.pnl-strong { color: var(--ink); }
.pnl-row-hl td { background: var(--surface); border-top: 1px solid var(--line); }
.pnl-neg { color: var(--neg); }
.pnl-pending { color: var(--warn-line); font-style: italic; }
/* tables sit directly inside .pnl-panel here, so soften the last border */
.pnl-panel > .pnl-table { margin-top: 4px; }

/* table */
.pnl-table-wrap { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: auto; }
.pnl-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pnl-table th {
  text-align: left; padding: 7px 11px; border-bottom: 1px solid var(--line);
  color: var(--ink-faint); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
  position: sticky; top: 0; background: var(--panel);
}
.pnl-table td { padding: 6px 11px; border-bottom: 1px solid var(--line-soft); font-variant-numeric: tabular-nums; }
.pnl-table tbody tr { transition: background 120ms var(--ease); }
.pnl-table tbody tr:last-child td { border-bottom: none; }

/* Only rows that actually drill in respond to the pointer. Hovering every row
   (including static ones) promised a click that wasn't there. */
.pnl-row-click { cursor: pointer; }
.pnl-row-click:hover { background: var(--surface); }
.pnl-row-click:active { background: var(--accent-wash); }
.pnl-row-click td:first-child { position: relative; padding-left: 21px; }
/* A caret marks the row as expandable, and turns when it's open. */
.pnl-row-click td:first-child::before {
  content: ""; position: absolute; left: 8px; top: 50%;
  width: 5px; height: 5px; margin-top: -3px;
  border-right: 1.5px solid var(--ink-faint); border-bottom: 1.5px solid var(--ink-faint);
  transform: rotate(-45deg); transform-origin: center;
  transition: transform 160ms var(--ease), border-color 160ms var(--ease);
}
.pnl-row-click:hover td:first-child::before { border-color: var(--accent); }
.pnl-row-active td:first-child::before { transform: rotate(45deg); border-color: var(--accent); }
.pnl-row-active { background: var(--accent-wash); }
.pnl-row-active:hover { background: var(--accent-wash); }
/* The whole cell is the hit target, not just the text. */
.pnl-row-click td:first-child a { display: block; margin: -6px -11px; padding: 6px 11px 6px 0; }
.pnl-num { text-align: right; }
.pnl-strong { font-weight: 640; }
.pnl-muted { color: var(--ink-faint); }
.pnl-pos { color: var(--pos); font-weight: 600; }
.pnl-negv { color: var(--neg); font-weight: 600; }

/* ── Hierarchy ────────────────────────────────────────────────────────────
   One number leads. Everything else is explicitly subordinate, so the eye has
   somewhere to land instead of scanning a wall of equal-weight figures. */
.pnl-headline {
  display: grid; grid-template-columns: auto 1fr; gap: 22px; align-items: center;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 14px 16px; margin-bottom: 10px;
}
@media (max-width: 860px) { .pnl-headline { grid-template-columns: 1fr; gap: 12px; } }
.pnl-headline-figure { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pnl-headline-label {
  font-size: 10.5px; font-weight: 680; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--ink-faint);
}
.pnl-headline-value {
  font-size: 38px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.05;
  font-variant-numeric: tabular-nums; color: var(--ink);
}
.pnl-headline-value.pending { font-size: 24px; color: var(--warn-line); font-style: italic; }
.pnl-headline-note { font-size: 11.5px; color: var(--ink-faint); }
/* Supporting figures: same row, deliberately much quieter than the headline. */
.pnl-supports { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 18px; }
.pnl-support-label { font-size: 10.5px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.05em; }
.pnl-support-value { font-size: 15px; font-weight: 620; font-variant-numeric: tabular-nums; margin-top: 2px; }

/* Change vs the previous month. Direction is the point, so it's a colour and a
   glyph, not another neutral figure to decode. */
.pnl-delta { font-size: 11.5px; font-weight: 620; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pnl-delta.up   { color: var(--pos); }
.pnl-delta.down { color: var(--neg); }
.pnl-delta.flat { color: var(--ink-faint); }
.pnl-delta-cell { padding-left: 8px; }
/* Rank marker: how big a slice of the month's cost this line is. Sits behind the
   label so scanning "what is eating the profit" is a glance, not arithmetic. */
.pnl-bar { position: relative; }
.pnl-bar::before {
  content: ""; position: absolute; left: 0; top: 2px; bottom: 2px;
  width: var(--w, 0%); background: var(--accent-wash); border-radius: 3px; z-index: 0;
}
.pnl-bar > * { position: relative; z-index: 1; }

/* Navigation progress: any click that goes to the server (drill-in, month
   change, compare toggle) shows work is happening instead of appearing dead. */
.pnl-progress {
  position: fixed; inset-block-start: 0; inset-inline: 0; height: 2px; z-index: 50;
  background: var(--accent); transform-origin: left center;
  animation: pnl-progress-in 900ms var(--ease) forwards;
  box-shadow: 0 0 8px oklch(0.52 0.15 275 / 0.5);
}
@keyframes pnl-progress-in {
  0%   { transform: scaleX(0); }
  60%  { transform: scaleX(0.7); }
  100% { transform: scaleX(0.92); }
}
/* Content dims slightly while a navigation is in flight. */
.pnl-busy { opacity: 0.6; transition: opacity 160ms var(--ease); pointer-events: none; }

/* pill for pending/status */
.pnl-pill { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 12px; font-weight: 550; }
.pnl-pill.pending { background: var(--accent-wash); color: var(--accent-ink); }
.pnl-pill.none    { background: var(--surface); color: var(--ink-soft); border: 1px solid var(--line); }
.pnl-pill.attn    { background: var(--warn-bg); color: oklch(0.42 0.09 75); }

/* controls row */
.pnl-controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.pnl-controls-right { display: flex; align-items: center; gap: 10px; }

/* panels / cards for login+settings */
.pnl-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px 13px; box-shadow: none; }
.pnl-field { display: flex; flex-direction: column; gap: 5px; }
.pnl-field-label { font-size: 13px; font-weight: 600; color: var(--ink); }
.pnl-form { display: flex; flex-direction: column; gap: 15px; }
.pnl-err { color: var(--neg); font-size: 13px; }
.pnl-note { font-size: 13px; color: var(--ink-soft); line-height: 1.6; }
.pnl-rule { border: none; border-top: 1px solid var(--line); margin: 6px 0; }
.pnl-section-label { font-size: 10.5px; font-weight: 680; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.05em; }
.pnl-empty { background: var(--panel); border: 1px dashed var(--line); border-radius: 10px; padding: 20px; text-align: center; color: var(--ink-soft); margin-top: 10px; }

.pnl-help { background: var(--surface); border: 1px solid var(--line); border-radius: 5px; padding: 10px 12px; font-size: 12px; color: var(--ink-soft); line-height: 1.5; }
.pnl-help code { background: var(--accent-wash); color: var(--accent-ink); padding: 1px 6px; border-radius: 5px; font-size: 12.5px; }
.pnl-help ol { margin: 8px 0 6px; padding-left: 20px; }
.pnl-help li { margin: 3px 0; }

@media (prefers-reduced-motion: reduce) {
  .pnl *, .pnl *::after, .pnl *::before { transition: none !important; }
  .pnl-spinner { animation: none !important; }
  /* Keep the progress bar as a static indicator rather than a moving one. */
  .pnl-progress { animation: none !important; transform: scaleX(1); }
  .pnl-btn:active:not(:disabled),
  .pnl-btn-primary:active:not(:disabled) { transform: none; }
}
`;

/** Inject the shared stylesheet once. Place near the top of each page. */
export function PnlStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}
