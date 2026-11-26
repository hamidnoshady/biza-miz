"use client";

/**
 * Moves keyboard/screen-reader focus to the destination page's own heading
 * once a navigation has actually committed — issue #909's "focus the
 * destination heading after a committed navigation, without stealing focus
 * on a background refresh."
 *
 * This watches the exact same signal `navigation-pending.tsx`'s own
 * "a navigation just committed" rule uses — the route actually served
 * (`pathname` + the query string) changing — not a weaker proxy like a click
 * or a loading boundary mounting. That is the whole guarantee: a same-scope
 * data refresh (`useResourceState`'s `retry()`, a `refreshKey` bump, a
 * background poll, a mutation re-fetching its own list) never changes the
 * served route, so it can never trigger this, no matter how it is wired.
 * A query-only change (e.g. the Directory's `?view=` tabs) *does* count —
 * it is as much a committed navigation as a new pathname, and the heading
 * text usually changes with it.
 *
 * The very first mount is deliberately skipped: that page is the one the
 * browser's own navigation already landed the user on (the address bar, a
 * reload, an external link), and grabbing focus from under it on load would
 * be a surprise, not a courtesy — screen readers already announce the page
 * on load themselves.
 *
 * "First mount" is tracked at module scope, not in a per-instance ref: each of
 * the four app shells is its own route segment, so launching an app from the
 * workspace rail (`/dashboard` → `/growth/overview`) *remounts* this manager.
 * A per-instance ref saw that remount as a fresh page load and left focus on
 * `body` (issue #1553); remembering the last committed route outside the
 * component makes the shell-to-shell switch look like what it is — a
 * navigation.
 *
 * The destination heading is not always mounted the instant the pathname
 * changes (a route segment can stream in after its own `loading.tsx`
 * fallback), so this polls a few animation frames for it rather than
 * grabbing whatever happens to have that id right now — bounded, like every
 * other wait in this codebase, not indefinite.
 */
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { PAGE_HEADING_ID } from "./page-heading-id";

/** Roughly half a second at 60fps — long enough for a streamed-in segment to mount its heading, short enough to give up if this route has none. */
const MAX_FOCUS_ATTEMPTS = 30;

/**
 * The route the last mounted manager committed to. Module scope, so it
 * survives the shell-to-shell remount a workspace→app launch causes.
 */
let lastCommittedRoute: string | null = null;

/** Test-only: forget the remembered route so a case starts like a fresh page load. */
export function resetHeadingFocusMemory() {
  lastCommittedRoute = null;
}

export function useFocusHeadingOnNavigate() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchString = searchParams.toString();
  const routeKey = `${pathname}?${searchString}`;

  useEffect(() => {
    const previousRoute = lastCommittedRoute;
    lastCommittedRoute = routeKey;

    // The page already on screen when this manager first mounts after a
    // document load is the browser's own landing, not a navigation this app
    // acknowledged — leave its focus alone. A manager that mounts with a
    // different remembered route is a shell remount mid-session, which *is* a
    // committed navigation.
    if (previousRoute === null || previousRoute === routeKey) return;

    let cancelled = false;
    let attempts = 0;
    let frame: number | null = null;

    const tryFocus = () => {
      if (cancelled) return;
      const heading = document.getElementById(PAGE_HEADING_ID);
      if (heading instanceof HTMLElement) {
        heading.focus({ preventScroll: false });
        return;
      }
      attempts += 1;
      if (attempts < MAX_FOCUS_ATTEMPTS) {
        frame = requestAnimationFrame(tryFocus);
      }
    };
    frame = requestAnimationFrame(tryFocus);

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [routeKey]);
}

/**
 * A do-nothing-but-mount-the-hook component, so the shell can place it as
 * plain JSX beside `NavigationPendingProvider` instead of every caller
 * needing to be a component that calls the hook itself.
 */
export function HeadingFocusManager() {
  useFocusHeadingOnNavigate();
  return null;
}
