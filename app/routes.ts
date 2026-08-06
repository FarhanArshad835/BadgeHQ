import { flatRoutes } from "@remix-run/fs-routes";
import { route } from "@remix-run/route-config";

// The standalone P&L tool is mapped EXPLICITLY (not by flat-file inference).
// Flat-file naming for the shared `/pnl-app` prefix kept producing a route whose
// single-fetch `.data` endpoint 404'd (the layout/index and underscore-sibling
// shapes both mis-resolved under v3_singleFetch + v3_lazyRouteDiscovery). Each
// of these is an independent leaf at its exact URL, so there is no parent/index
// ambiguity and every `.data` endpoint exists.
const pnlAppRoutes = [
  route("/pnl-app", "routes/pnlapp.dashboard.tsx"),
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
