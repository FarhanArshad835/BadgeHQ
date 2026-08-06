import { Outlet } from "@remix-run/react";

/**
 * Layout route for the standalone P&L tool. Flat-file routing needs this parent
 * to exist for `pnl-app._index.tsx` to match the bare `/pnl-app` URL — without
 * it, only the explicit children (/pnl-app/login, /pnl-app/settings) resolve and
 * `/pnl-app` itself 404s ("No route matches URL /pnl-app").
 *
 * It's a pure pass-through: each child page renders its own full chrome, so this
 * only provides the routing parent, no shared UI.
 */
export default function PnlAppLayout() {
  return <Outlet />;
}
