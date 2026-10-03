/**
 * The bar across the top of every scanner, matching the prototype.
 *
 * Carries today's counts as well as the links: an operator glancing up should
 * be able to see how the shift is going without opening another page.
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
    <>
    <div className="topbar">
      <nav className="nav" aria-label="Main">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.href}
            className={active === t.key ? "active" : undefined}
            aria-current={active === t.key ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="top-right">
        {today > 0 && (
          <span className="today">
            Today: {(c.dispatch || 0).toLocaleString("en-IN")} dispatched,{" "}
            {(c.rto || 0).toLocaleString("en-IN")} RTO,{" "}
            {(c["customer-return"] || 0).toLocaleString("en-IN")} returns
          </span>
        )}
        {/* Hidden on a phone, where the bar is the four links and nothing
            else — a narrow bar is for getting somewhere, and Sign out beside
            the tab you are reaching for is a mis-tap that ends the shift.
            It moves to the foot of the page there instead. */}
        <a className="btn-ghost sign-out" href="/pnl-app/scan/logout">
          Sign out
        </a>
      </div>
    </div>
    {/* Only on a phone: out of the way of everything pressed during a shift. */}
    <a className="sign-out-foot" href="/pnl-app/scan/logout">
      Sign out
    </a>
    </>
  );
}
