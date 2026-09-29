/**
 * The bar across the top of every scanner.
 *
 * Carries today's counts as well as the links: an operator glancing up should be
 * able to see how the shift is going without opening another page.
 */
import { Link } from "@remix-run/react";

const TABS = [
  { key: "dispatch", href: "/pnl-app/scan/dispatch", label: "Dispatch" },
  { key: "returns", href: "/pnl-app/scan/returns", label: "Inbound" },
  { key: "claims", href: "/pnl-app/scan/claims", label: "Claims" },
  { key: "history", href: "/pnl-app/scan/history", label: "History" },
];

export function ScanNav({
  active,
  counts,
}: {
  active: string;
  counts?: Record<string, number>;
}) {
  const c = counts || {};
  const today = (c.dispatch || 0) + (c.rto || 0) + (c["customer-return"] || 0);

  return (
    <div className="pnl-scan-nav">
      <div className="pnl-scan-tabs">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.href}
            className={`pnl-scan-tab ${active === t.key ? "pnl-scan-tab--on" : ""}`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <div className="pnl-scan-nav-right">
        {today > 0 && (
          <span className="pnl-sub" style={{ fontSize: 12 }}>
            Today: {c.dispatch || 0} dispatched, {c.rto || 0} RTO, {c["customer-return"] || 0} returns
          </span>
        )}
        <a className="pnl-scan-tab" href="/pnl-app/scan/logout">Sign out</a>
      </div>
    </div>
  );
}
