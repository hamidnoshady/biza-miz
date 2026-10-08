"use client";

/**
 * A screen with unsaved work must not lose it to a stray click — issue #835 §7.
 *
 * `beforeunload` was the only protection the payroll wage list had, and it
 * covers exactly two things: reloading and closing the tab. The ordinary way a
 * person loses their edits is a *client-side* navigation — a sidebar entry, a
 * rail launcher, a section chip — which never unloads the page, so the browser
 * has nothing to warn about: the section unmounts and every typed salary
 * disappears in silence. The comment in the screen claimed otherwise; it was
 * not true.
 *
 * `useUnsavedChangesGuard(dirty)` closes that gap for one screen, and any other
 * screen can adopt it the same way:
 *
 *   - **links** — while `dirty`, a click on any same-origin anchor that would
 *     change the page is caught in the *capture* phase, before Next's `<Link>`
 *     handler sees it, and turned into a prompt. Capturing at the document means
 *     the sidebar, the workspace rail and any future link are covered without
 *     each knowing the guard exists. Clicks that mean something else are left
 *     alone: modified clicks (new tab/window), `target="_blank"`, `download`,
 *     other origins, and links to the page you are already on.
 *   - **programmatic navigation** — `router.push` from a button cannot be seen
 *     by a click listener, so such callers route through `guardedNavigate`
 *     (the accounting section chips do).
 *   - **reload / close** — the browser's own `beforeunload` prompt, as before.
 *
 * The prompt offers exactly two ways out: stay (nothing changes) or leave and
 * discard. Browser Back/Forward is *not* intercepted: the App Router offers no
 * way to cancel a history traversal, and pushing sentinel history entries to
 * fake one corrupts the back stack; a screen that wants to survive it keeps its
 * own drafts (the payroll section does — see `payroll-draft-memory.ts`).
 *
 * The guard never decides *whether* something is dirty and never saves; it only
 * stands between a click and the navigation.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PendingNavigation {
  /** Where the person was going — for the prompt and for tests. */
  href: string;
  /** Carries the navigation out once they have chosen to leave. */
  proceed: () => void;
}

interface ActiveGuard {
  isDirty: () => boolean;
  ask: (pending: PendingNavigation) => void;
}

/** The guard currently armed on this page, if any. One screen is dirty at a time. */
let activeGuard: ActiveGuard | null = null;

/**
 * Run a programmatic navigation through the armed guard.
 *
 * With nothing dirty this is just `proceed()`. With unsaved work it opens the
 * prompt instead, and `proceed` runs only if the person chooses to leave.
 * Callers keep their own `router.push`/`replace` — they hand it over, so the
 * guard never has to know how the navigation is performed.
 */
export function guardedNavigate(href: string, proceed: () => void): void {
  if (activeGuard?.isDirty()) {
    activeGuard.ask({ href, proceed });
    return;
  }
  proceed();
}

/**
 * The in-app destination of a click, or null when the click is not an in-app
 * page change (so the guard must stay out of its way).
 */
export function internalNavigationTarget(event: MouseEvent): string | null {
  if (event.defaultPrevented) return null;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

  const node = event.target;
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const anchor = element?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute("download")) return null;
  const targetAttribute = anchor.getAttribute("target");
  if (targetAttribute && targetAttribute !== "_self") return null;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  // Another origin is a real page load: `beforeunload` is the right guard for it.
  if (url.origin !== window.location.origin) return null;
  // The same page (a hash jump, a link back to where you already are) loses nothing.
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface UnsavedChangesGuard {
  /** True while the «leave this page?» prompt is showing. */
  open: boolean;
  /** Where the person was going when the prompt opened. */
  href: string | null;
  /** Dismiss the prompt and stay put. */
  stay: () => void;
  /** Give the unsaved work up and carry on to where they were going. */
  leave: () => void;
}

export function useUnsavedChangesGuard(
  dirty: boolean,
  options: {
    /** Called when the person chooses to leave — drop the drafts here. Runs before the navigation. */
    onDiscard?: () => void;
  } = {},
): UnsavedChangesGuard {
  const router = useRouter();
  const [pending, setPending] = useState<PendingNavigation | null>(null);

  // Read through refs so the listeners below never need re-registering when
  // these change, and `leave` always calls the latest callback.
  const dirtyRef = useRef(dirty);
  const onDiscardRef = useRef(options.onDiscard);
  useEffect(() => {
    dirtyRef.current = dirty;
    onDiscardRef.current = options.onDiscard;
  });

  useEffect(() => {
    if (!dirty) return;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    function onClick(event: MouseEvent) {
      const href = internalNavigationTarget(event);
      if (href === null) return;
      // Stop it here — before React's handlers, so Next's `<Link>` never starts
      // the navigation — and ask instead.
      event.preventDefault();
      event.stopPropagation();
      setPending({ href, proceed: () => router.push(href) });
    }

    const guard: ActiveGuard = { isDirty: () => dirtyRef.current, ask: setPending };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    activeGuard = guard;
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      if (activeGuard === guard) activeGuard = null;
    };
  }, [dirty, router]);

  const stay = useCallback(() => setPending(null), []);

  const leave = useCallback(() => {
    const next = pending;
    setPending(null);
    if (!next) return;
    onDiscardRef.current?.();
    next.proceed();
  }, [pending]);

  return { open: pending !== null, href: pending?.href ?? null, stay, leave };
}

/**
 * The prompt. Plain RTL dialog from the design system — the same shell the
 * payroll void confirmation uses — with the safe choice first and focused.
 */
export function UnsavedChangesDialog({
  guard,
  children,
}: {
  guard: UnsavedChangesGuard;
  /** What is at stake, in the screen's own words («۳ تغییر ذخیره‌نشده …»). */
  children: ReactNode;
}) {
  return (
    <Dialog open={guard.open} onOpenChange={(open) => !open && guard.stay()}>
      <DialogContent dir="rtl" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>تغییرات ذخیره‌نشده</DialogTitle>
          <DialogDescription className="leading-6">{children}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button type="button" onClick={guard.stay} autoFocus>
            ماندن در صفحه
          </Button>
          <Button type="button" variant="destructive" onClick={guard.leave}>
            ترک صفحه و حذف تغییرات
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
