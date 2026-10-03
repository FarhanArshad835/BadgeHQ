/**
 * A progress bar for any navigation or form submission in flight.
 *
 * Every page except the dashboard answered a click with nothing: a filter, a
 * tab, a login, a settings save all go to the server, and until it replies the
 * page is identical to one that ignored the press. On a bench that reads as
 * broken and gets pressed again — which, for a form, submits it twice.
 *
 * One component rather than the same five lines per route, so a page added
 * later cannot quietly ship without it.
 */
import { useNavigation } from "@remix-run/react";

const CSS = `
/* Fixed to the top of the window so it is visible from any scroll position,
   and deliberately unscoped: the bar renders outside whichever design system
   the page uses, and must not fade with content that dims while busy. */
.busy-bar {
  position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 100;
  background: #3b4bc8; transform-origin: left center;
  animation: busy-grow 1s cubic-bezier(.2,.8,.2,1) forwards;
}
@keyframes busy-grow {
  0% { transform: scaleX(0); } 55% { transform: scaleX(.7); } 100% { transform: scaleX(.93); }
}
@media (prefers-reduced-motion: reduce) {
  .busy-bar { animation: none; transform: scaleX(1); opacity: .6; }
}
`;

export function BusyBar() {
  const nav = useNavigation();
  // "submitting" covers a form POST, "loading" a filter or a link. Both leave
  // the operator waiting, so both earn the bar.
  const busy = nav.state !== "idle";
  if (!busy) return null;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="busy-bar" key={nav.location?.key ?? "submit"} aria-hidden />
    </>
  );
}

/** True while the page is waiting on the server, for disabling a control. */
export function useBusy(): boolean {
  return useNavigation().state !== "idle";
}
