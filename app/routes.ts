import { flatRoutes } from "@remix-run/fs-routes";
import { route } from "@remix-run/route-config";

// The standalone P&L tool is mapped EXPLICITLY (not by flat-file inference).
//
// Live probing showed the single-fetch `.data` endpoint 404'd ONLY for the bare
// `/pnl-app` route, while `/pnl-app/login.data` and `/pnl-app/settings.data`
// resolved fine. The cause: on Vercel's Remix build, a route path that is also a
// PREFIX of its sibling paths (`/pnl-app` vs `/pnl-app/login`) doesn't get a
// working `/pnl-app.data` rewrite — it's shadowed by the `/pnl-app/*` pattern.
// The Sync button's POST goes to `/pnl-app.data`, so it 404'd.
//
// Fix: no route sits at a prefix-of-siblings path. The dashboard lives at
// `/pnl-app/home` (its `.data` is safe), and `/pnl-app` is just a redirect to it.
const pnlAppRoutes = [
  route("/pnl-app", "routes/pnlapp.redirect.tsx"),
  route("/pnl-app/home", "routes/pnlapp.dashboard.tsx"),
  route("/pnl-app/login", "routes/pnlapp.login.tsx"),
  route("/pnl-app/reset", "routes/pnlapp.reset.tsx"),
  route("/pnl-app/settings", "routes/pnlapp.settings.tsx"),
  route("/pnl-app/export", "routes/pnlapp.export.tsx"),
  route("/pnl-app/logout", "routes/pnlapp.logout.tsx"),
  // Warehouse scanners. Same /pnl-app prefix so they share the session
  // mechanism, but their cookie is scoped one level deeper (/pnl-app/scan) so
  // the scanner password cannot reach the P&L.
  //
  // /pnl-app/scan is a bare redirect for the same reason /pnl-app is: a path
  // that is a PREFIX of its siblings gets no working .data endpoint on Vercel.
  route("/pnl-app/scan", "routes/pnlapp.scan.redirect.tsx"),
  route("/pnl-app/scan/login", "routes/pnlapp.scan.login.tsx"),
  route("/pnl-app/scan/logout", "routes/pnlapp.scan.logout.tsx"),
  route("/pnl-app/scan/dispatch", "routes/pnlapp.scan.dispatch.tsx"),
  route("/pnl-app/scan/returns", "routes/pnlapp.scan.returns.tsx"),
  // The mobile inbound scanner. Its own path rather than a breakpoint on
  // /returns: it is a different design, not a narrower one, and a bench
  // phone can be bookmarked straight to it.
  route("/pnl-app/scan/m", "routes/pnlapp.scan.m.tsx"),
  route("/pnl-app/scan/history", "routes/pnlapp.scan.history.tsx"),
  route("/pnl-app/scan/claims", "routes/pnlapp.scan.claims.tsx"),
];

// flatRoutes() owns every other route; it ignores the pnlapp.* files so they
// aren't also registered at their flat-file paths (/pnlapp/dashboard, etc.).
export default [
  ...(await flatRoutes({ ignoredRouteFiles: ["**/pnlapp.*"] })),
  ...pnlAppRoutes,
];
