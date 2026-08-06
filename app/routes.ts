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
  route("/pnl-app/settings", "routes/pnlapp.settings.tsx"),
  route("/pnl-app/logout", "routes/pnlapp.logout.tsx"),
];

// flatRoutes() owns every other route; it ignores the pnlapp.* files so they
// aren't also registered at their flat-file paths (/pnlapp/dashboard, etc.).
export default [
  ...(await flatRoutes({ ignoredRouteFiles: ["**/pnlapp.*"] })),
  ...pnlAppRoutes,
];
