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
  --shadow:     0 1px 2px oklch(0.28 0.03 275 / 0.06), 0 4px 16px oklch(0.28 0.03 275 / 0.05);
  --radius:     12px;
  --ease:       cubic-bezier(0.22, 1, 0.36, 1);
}

.pnl {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding: 40px 20px 64px;
}
.pnl-wrap { max-width: 940px; margin: 0 auto; }
.pnl-wrap.narrow { max-width: 460px; }

.pnl-h1 { margin: 0; font-size: 26px; font-weight: 680; letter-spacing: -0.02em; }
.pnl-sub { color: var(--ink-soft); font-size: 14px; line-height: 1.55; }

/* header row */
.pnl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22px; gap: 16px; }
.pnl-headlinks { display: flex; gap: 20px; align-items: center; }

/* text link */
.pnl-link {
  color: var(--accent-ink); text-decoration: none; font-size: 14px; font-weight: 550;
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
.pnl-btn {
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  padding: 10px 18px; border-radius: 9px; border: 1px solid transparent;
  transition: transform 120ms var(--ease), box-shadow 160ms var(--ease), background 140ms var(--ease), opacity 120ms var(--ease);
}
.pnl-btn-primary { background: var(--ink); color: oklch(0.99 0.003 275); box-shadow: var(--shadow); }
.pnl-btn-primary:hover { background: var(--accent-ink); box-shadow: 0 2px 6px oklch(0.42 0.16 275 / 0.28), 0 8px 22px oklch(0.42 0.16 275 / 0.18); }
.pnl-btn-primary:active { transform: translateY(1px); box-shadow: 0 1px 2px oklch(0.42 0.16 275 / 0.3); }
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
  font: inherit; font-size: 14px; color: var(--ink); background: var(--panel);
  padding: 9px 34px 9px 13px; border: 1px solid var(--line); border-radius: 9px;
  cursor: pointer; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1L5 5L9 1' stroke='%236b6b80' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 13px center;
  transition: border-color 140ms var(--ease), box-shadow 140ms var(--ease);
}
.pnl-select:hover { border-color: var(--ink-faint); }
.pnl-select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-wash); }

/* text input */
.pnl-input {
  font: inherit; font-size: 14px; color: var(--ink); background: var(--panel);
  width: 100%; box-sizing: border-box;
  padding: 10px 13px; border: 1px solid var(--line); border-radius: 9px;
  transition: border-color 140ms var(--ease), box-shadow 140ms var(--ease);
}
.pnl-input::placeholder { color: var(--ink-faint); }
.pnl-input:hover { border-color: var(--ink-faint); }
.pnl-input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-wash); }

/* tabs */
.pnl-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 22px; }
.pnl-tab {
  font: inherit; font-size: 14px; font-weight: 550; cursor: pointer;
  background: none; border: none; color: var(--ink-soft);
  padding: 10px 16px; position: relative;
  transition: color 140ms var(--ease);
}
.pnl-tab::after {
  content: ""; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px;
  background: var(--ink); border-radius: 2px 2px 0 0;
  transform: scaleX(0); transition: transform 200ms var(--ease);
}
.pnl-tab:hover { color: var(--ink); }
.pnl-tab[data-active="true"] { color: var(--ink); font-weight: 640; }
.pnl-tab[data-active="true"]::after { transform: scaleX(1); }
.pnl-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }

/* banner */
.pnl-banner { padding: 12px 15px; border-radius: 10px; font-size: 13.5px; line-height: 1.5; border: 1px solid transparent; }
.pnl-banner.info { background: var(--surface); border-color: var(--line); color: var(--ink-soft); }
.pnl-banner.ok   { background: var(--ok-bg); border-color: oklch(0.86 0.07 155); color: oklch(0.34 0.09 155); }
.pnl-banner.warn { background: var(--warn-bg); border-color: var(--warn-line); color: oklch(0.42 0.09 75); }
.pnl-banner.bad  { background: oklch(0.96 0.04 35); border-color: oklch(0.86 0.08 35); color: oklch(0.42 0.12 35); }

/* KPI tiles */
.pnl-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 12px; margin-bottom: 14px; }
.pnl-kpi {
  background: var(--panel); border: 1px solid var(--line-soft); border-radius: var(--radius);
  padding: 16px 18px; box-shadow: var(--shadow);
  transition: border-color 160ms var(--ease), transform 160ms var(--ease);
}
.pnl-kpi:hover { border-color: var(--line); transform: translateY(-1px); }
.pnl-kpi-label { font-size: 12.5px; color: var(--ink-faint); margin-bottom: 6px; letter-spacing: 0.01em; }
.pnl-kpi-value { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.pnl-kpi-value.neg { color: var(--neg); }
.pnl-kpi.headline { background: var(--accent-wash); border-color: oklch(0.88 0.04 275); }
.pnl-kpi.headline .pnl-kpi-value { font-size: 25px; font-weight: 720; color: var(--accent-ink); }

/* table */
.pnl-table-wrap { background: var(--panel); border: 1px solid var(--line-soft); border-radius: var(--radius); overflow: auto; box-shadow: var(--shadow); }
.pnl-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.pnl-table th {
  text-align: left; padding: 11px 16px; border-bottom: 1px solid var(--line);
  color: var(--ink-faint); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em;
  position: sticky; top: 0; background: var(--panel);
}
.pnl-table td { padding: 12px 16px; border-bottom: 1px solid var(--line-soft); font-variant-numeric: tabular-nums; }
.pnl-table tbody tr { transition: background 120ms var(--ease); }
.pnl-table tbody tr:hover { background: var(--surface); }
.pnl-table tbody tr:last-child td { border-bottom: none; }
.pnl-num { text-align: right; }
.pnl-strong { font-weight: 640; }
.pnl-muted { color: var(--ink-faint); }
.pnl-pos { color: var(--pos); font-weight: 600; }
.pnl-negv { color: var(--neg); font-weight: 600; }

/* pill for pending/status */
.pnl-pill { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 12px; font-weight: 550; }
.pnl-pill.pending { background: var(--accent-wash); color: var(--accent-ink); }
.pnl-pill.none    { background: var(--surface); color: var(--ink-soft); border: 1px solid var(--line); }
.pnl-pill.attn    { background: var(--warn-bg); color: oklch(0.42 0.09 75); }

/* controls row */
.pnl-controls { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
.pnl-controls-right { display: flex; align-items: center; gap: 14px; }

/* panels / cards for login+settings */
.pnl-panel { background: var(--panel); border: 1px solid var(--line-soft); border-radius: 16px; padding: 30px; box-shadow: var(--shadow); }
.pnl-field { display: flex; flex-direction: column; gap: 5px; }
.pnl-field-label { font-size: 13px; font-weight: 600; color: var(--ink); }
.pnl-form { display: flex; flex-direction: column; gap: 15px; }
.pnl-err { color: var(--neg); font-size: 13px; }
.pnl-note { font-size: 13px; color: var(--ink-soft); line-height: 1.6; }
.pnl-rule { border: none; border-top: 1px solid var(--line); margin: 6px 0; }
.pnl-section-label { font-size: 11.5px; font-weight: 680; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.05em; }
.pnl-empty { background: var(--panel); border: 1px dashed var(--line); border-radius: var(--radius); padding: 30px; text-align: center; color: var(--ink-soft); margin-top: 14px; }

.pnl-help { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; font-size: 13px; color: var(--ink-soft); line-height: 1.6; }
.pnl-help code { background: var(--accent-wash); color: var(--accent-ink); padding: 1px 6px; border-radius: 5px; font-size: 12.5px; }
.pnl-help ol { margin: 8px 0 6px; padding-left: 20px; }
.pnl-help li { margin: 3px 0; }

@media (prefers-reduced-motion: reduce) {
  .pnl *, .pnl *::after { transition: none !important; }
  .pnl-spinner { animation: none !important; }
}
`;

/** Inject the shared stylesheet once. Place near the top of each page. */
export function PnlStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}
