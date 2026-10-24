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
 * The very first render is deliberately skipped: that page is the one the
 * browser's own navigation already landed the user on (the address bar, a
 * reload, an external link), and grabbing focus from under it on load would
 * be a surprise, not a courtesy — screen readers already announce the page
 * on load themselves.
 *
 * The destination heading is not always mounted the instant the pathname
 * changes (a route segment can stream in after its own `loading.tsx`
 * fallback), so this polls a few animation frames for it rather than
 * grabbing whatever happens to have that id right now — bounded, like every
 * other wait in this codebase, not indefinite.
 */
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { PAGE_HEADING_ID } from "./page-heading-id";

/** Roughly half a second at 60fps — long enough for a streamed-in segment to mount its heading, short enough to give up if this route has none. */
const MAX_FOCUS_ATTEMPTS = 30;

export function useFocusHeadingOnNavigate() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchString = searchParams.toString();
  const hasCommittedOnceRef = useRef(false);

  useEffect(() => {
    // The page already on screen when this hook first mounts is the
    // browser's own landing, not a navigation this app acknowledged —
    // leave its focus alone.
    if (!hasCommittedOnceRef.current) {
      hasCommittedOnceRef.current = true;
      return;
    }

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
  }, [pathname, searchString]);
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
