"use client";

/**
 * A single, consistent "we heard you, we're on our way" acknowledgment for
 * every kind of in-app navigation — issue #909 §9/§13 ("navigation
 * acknowledgment inconsistency across sidebar/chips/quick-actions/browser
 * nav").
 *
 * Before this, each surface answered a click differently: a sidebar `<Link>`
 * gave the browser's own (often invisible, on a fast connection) link
 * styling and nothing else until the new route painted; an Accounting
 * section chip/quick action (a `<button>` calling `router.push` through
 * `guardedNavigate`) gave no feedback at all between the click and the next
 * screen; Back/Forward gave whatever the browser itself shows. On a slow
 * connection or a cold dynamic import, all four leave a person wondering
 * whether the click landed.
 *
 * This is the one owner of that acknowledgment, mounted once in the
 * persistent shell (`workspace-shell.tsx`) so it survives the very
 * navigation it is reporting on:
 *
 *  - **Literal links** (the sidebar, and anything else built from
 *    `next/link`) are covered for free by one capture-phase `click` listener
 *    here, reusing `internalNavigationTarget` — the exact same same-origin/
 *    same-page/modified-click rules `unsaved-changes-guard.tsx` already
 *    applies, so "was this actually a navigation" is answered identically in
 *    both places. It deliberately does nothing when a guard is currently
 *    dirty (`isGuardDirty()`): that click is the guard's to decide, and
 *    acknowledging a navigation that a "leave this page?" prompt might still
 *    cancel would be a lie.
 *  - **Chips/quick actions** (`router.push` behind `guardedNavigate`, with no
 *    `<a>` for the click listener to see) call `beginNavigation` explicitly
 *    at the one place that already funnels every one of them —
 *    `accounting-manager.tsx`'s `goToSection`.
 *  - **The guard's own confirmed "leave"** — dirty, then the person chooses
 *    to discard and go — is covered by `NAVIGATION_COMMITTED_EVENT`, which
 *    `unsaved-changes-guard.tsx` dispatches from `leave()`.
 *  - **Browser Back/Forward** cannot be intercepted (nor should it be — see
 *    that file's own header), but `popstate` fires once the address bar has
 *    already changed, which is enough to show the same acknowledgment until
 *    the router catches up.
 *
 * Clearing is a single rule, not four: the moment the pathname or query
 * actually served changes, whatever was pending is done — no caller ever
 * marks its own completion. A safety timeout guards the one case nothing
 * else can: a navigation that silently never resolves (e.g. a `router.push`
 * no route handles) would otherwise leave the acknowledgment on screen
 * forever.
 */
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { internalNavigationTarget, isGuardDirty } from "./unsaved-changes-guard";
import { NAVIGATION_COMMITTED_EVENT, type NavigationCommittedDetail } from "./navigation-events";

/** How long an acknowledged navigation may sit "pending" before this gives up on it (see module doc). */
const NAVIGATION_PENDING_TIMEOUT_MS = 8_000;

interface NavigationPendingContextValue {
  /** Where the pending navigation is going; null when nothing is in flight. */
  pendingHref: string | null;
  /** Mark a navigation as committed — call this at the moment it actually starts, never speculatively. */
  beginNavigation: (href: string) => void;
}

const NavigationPendingContext = createContext<NavigationPendingContextValue | null>(null);

/** The here-and-now location, in the same `pathname+search` shape `internalNavigationTarget` reports hrefs in. */
function currentLocationKey(pathname: string, search: string): string {
  return search ? `${pathname}?${search}` : pathname;
}

export function NavigationPendingProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Compared and depended on as a string, not the `searchParams` object
  // itself: `useSearchParams()`'s contract is a stable reference across
  // renders that did not change the query, but nothing here needs to lean on
  // that — a plain string is unambiguous either way, and keeps this
  // provider's clearing rule honest even against a renderer that re-creates
  // the object on every pass.
  const searchString = searchParams.toString();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPendingHref(null);
  }, []);

  const beginNavigation = useCallback(
    (href: string) => {
      // A link back to the page already on screen (a hash jump, a filter
      // chip that happens to resolve to the current URL) commits nothing —
      // never show "در حال انتقال…" for a navigation that is not one.
      if (href === currentLocationKey(pathname, searchString)) return;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setPendingHref(href);
      timerRef.current = setTimeout(clear, NAVIGATION_PENDING_TIMEOUT_MS);
    },
    [pathname, searchString, clear],
  );

  // The one clearing rule: the served route actually changed. Every pending
  // navigation this provider ever marks ends here, regardless of which of
  // the four surfaces in the module doc started it.
  useEffect(() => {
    clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchString]);


  useEffect(() => {
    function onClick(event: MouseEvent) {
      // A dirty screen's own guard owns this click (it may still cancel the
      // navigation entirely) — see this module's header comment.
      if (isGuardDirty()) return;
      const href = internalNavigationTarget(event);
      if (href !== null) beginNavigation(href);
    }
    function onCommitted(event: Event) {
      const detail = (event as CustomEvent<NavigationCommittedDetail>).detail;
      if (detail?.href) beginNavigation(detail.href);
    }
    function onPopState() {
      beginNavigation(currentLocationKey(window.location.pathname, window.location.search.replace(/^\?/, "")));
    }
    document.addEventListener("click", onClick, true);
    window.addEventListener(NAVIGATION_COMMITTED_EVENT, onCommitted);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(NAVIGATION_COMMITTED_EVENT, onCommitted);
      window.removeEventListener("popstate", onPopState);
    };
  }, [beginNavigation]);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const value = useMemo<NavigationPendingContextValue>(() => ({ pendingHref, beginNavigation }), [pendingHref, beginNavigation]);

  return <NavigationPendingContext.Provider value={value}>{children}</NavigationPendingContext.Provider>;
}

/**
 * Reads the shared navigation-acknowledgment state. Outside the provider
 * (a few standalone pages — `/login`, `/setup` — render without it) this
 * answers "never pending" rather than throwing, since those surfaces have no
 * persistent shell to show the indicator in anyway.
 */
export function useNavigationPending(): { pending: boolean; href: string | null; beginNavigation: (href: string) => void } {
  const ctx = useContext(NavigationPendingContext);
  if (!ctx) return { pending: false, href: null, beginNavigation: () => {} };
  return { pending: ctx.pendingHref !== null, href: ctx.pendingHref, beginNavigation: ctx.beginNavigation };
}

/**
 * The acknowledgment itself — a plain status line, not a progress bar: this
 * is "we heard you", never a fabricated percentage (issue #909's UX
 * requirements rule those out outright; there is nothing here to measure a
 * percentage of). One `role="status"` region, so it is the single announcer
 * for "a navigation is in flight" — the destination page's own loading
 * boundary (its skeleton) is a separate region and makes no navigation claim
 * of its own.
 */
export function NavigationPendingIndicator() {
  const { pending } = useNavigationPending();
  if (!pending) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="در حال انتقال به صفحهٔ بعد"
      className="flex shrink-0 items-center gap-2 border-b border-border/80 bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground sm:px-4"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse"
      />
      در حال انتقال…
    </div>
  );
}
