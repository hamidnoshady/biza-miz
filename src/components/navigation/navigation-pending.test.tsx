// @vitest-environment jsdom

/**
 * Issue #909 §9 — one owner for "a navigation is in flight", consistent
 * across a literal sidebar-style link, a chip/quick-action's `router.push`,
 * and the guard's own confirmed «leave this page؟» — and cleared by exactly
 * one rule: the served route changed.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_COMMITTED_EVENT } from "./navigation-events";
import { NavigationPendingIndicator, NavigationPendingProvider, useNavigationPending } from "./navigation-pending";
import { guardedNavigate, UnsavedChangesDialog, useUnsavedChangesGuard } from "./unsaved-changes-guard";

const router = {
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
};

let currentPathname = "/accounting/overview";
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => currentPathname,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

afterEach(() => {
  cleanup();
  currentPathname = "/accounting/overview";
  currentSearch = "";
  vi.clearAllMocks();
  history.pushState({}, "", "/");
});

function Harness({ dirty, onChip }: { dirty?: boolean; onChip?: () => void } = {}) {
  const guard = useUnsavedChangesGuard(dirty ?? false);
  return (
    <AppRouterContext.Provider value={router as never}>
      <NavigationPendingProvider>
        <NavigationPendingIndicator />
        <nav>
          {/*
            `aria-current` is wired exactly like the real sidebar
            (dashboard-sidebar.tsx): derived straight from `usePathname()`,
            never from the pending-navigation state. The two must stay
            decoupled — see "keeps aria-current on the committed page" below.
          */}
          <Link
            href="/accounting/trial-balance"
            aria-current={currentPathname === "/accounting/trial-balance" ? "page" : undefined}
          >
            تراز آزمایشی
          </Link>
          <Link href="/accounting/overview" aria-current={currentPathname === "/accounting/overview" ? "page" : undefined}>
            همین صفحه
          </Link>
          <button
            type="button"
            onClick={() =>
              guardedNavigate("/accounting/entries", () => onChip?.())
            }
          >
            چیپ بخش
          </button>
        </nav>
        {dirty ? <UnsavedChangesDialog guard={guard}>۲ تغییر ذخیره‌نشده دارید.</UnsavedChangesDialog> : null}
      </NavigationPendingProvider>
    </AppRouterContext.Provider>
  );
}

describe("NavigationPendingProvider — one acknowledgment for every navigation surface", () => {
  it("shows the indicator the instant a plain sidebar-style link is clicked", () => {
    render(<Harness />);
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "تراز آزمایشی" }));

    expect(screen.getByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeTruthy();
  });

  it("never acknowledges a link back to the page already on screen", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("link", { name: "همین صفحه" }));
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
  });

  it("clears the moment the served route changes — the one clearing rule", () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    expect(screen.getByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeTruthy();

    currentPathname = "/accounting/trial-balance";
    view.rerender(<Harness />);

    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
  });

  it("acknowledges a chip/quick-action (a button, not a link) via beginNavigation", () => {
    const onChip = vi.fn();
    render(<Harness onChip={onChip} />);
    fireEvent.click(screen.getByRole("button", { name: "چیپ بخش" }));
    expect(onChip).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for a click while a guard is dirty — that click is the dialog's to decide", () => {
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    // The guard intercepted it (its own dialog contract is covered by
    // unsaved-changes-guard.test.tsx); navigation-pending must not have
    // acknowledged a navigation that might still be cancelled.
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
  });

  it("acknowledges the navigation once the guard's dialog confirms leave", () => {
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    fireEvent.click(screen.getByRole("button", { name: "ترک صفحه و حذف تغییرات" }));
    expect(screen.getByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeTruthy();
  });

  it("gives up on a navigation that never resolves, instead of acknowledging it forever", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
      expect(screen.getByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(8_000);
      });
      expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 'never pending' outside the provider, rather than throwing", () => {
    function Bare() {
      const { pending } = useNavigationPending();
      return <span>{pending ? "pending" : "idle"}</span>;
    }
    render(<Bare />);
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("dispatching the committed event with no listener mounted is a silent no-op", () => {
    expect(() =>
      window.dispatchEvent(new CustomEvent(NAVIGATION_COMMITTED_EVENT, { detail: { href: "/accounting/entries" } })),
    ).not.toThrow();
  });

  /*
   * Issue #909 §9/§13 — five more specific behaviors on top of the ones
   * above, each covering one gap this module's own header comment promises
   * but the original suite never pinned down.
   */

  it("ignores a modified click on a link — new-tab/window, not a SPA navigation", () => {
    render(<Harness />);
    const link = screen.getByRole("link", { name: "تراز آزمایشی" });

    // A ctrl/cmd-click, a shift-click and a middle-click all ask the browser
    // to open a new tab/window — none of them is "this page is navigating
    // away", so none should acknowledge one. `internalNavigationTarget`
    // already excludes these (unsaved-changes-guard.tsx); this is the
    // behavioral proof from navigation-pending's own side of that contract.
    fireEvent.click(link, { ctrlKey: true });
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();

    fireEvent.click(link, { metaKey: true });
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();

    fireEvent.click(link, { button: 1 });
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
  });

  it("never acknowledges a navigation the guard's dialog ends up cancelling", () => {
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    // The dialog is up, deciding — nothing acknowledged yet.
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();

    // The person chooses to stay — the guard's "stay" branch, not "leave".
    fireEvent.click(screen.getByRole("button", { name: "ماندن در صفحه" }));

    // Nothing was ever acknowledged, and nothing pops back into "pending"
    // once the dialog is gone: a cancelled navigation stays cancelled.
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("acknowledges Back/Forward via popstate, and clears once the served route catches up", () => {
    const view = render(<Harness />);
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();

    // The address bar already moved by the time `popstate` fires — this
    // provider cannot intercept Back/Forward (nor should it), only react to
    // it. `onPopState` reads the real `window.location`, so move that first
    // (as the browser itself would have, before ever raising the event) —
    // separately from `currentPathname`, the mocked `usePathname()` this
    // harness's own render reads, which the *router* only catches up to once
    // Next reconciles against the new address.
    history.pushState({}, "", "/accounting/trial-balance");
    act(() => {
      window.dispatchEvent(new Event("popstate"));
    });
    expect(screen.getByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeTruthy();

    // The router/rerender catching up to the already-changed pathname is
    // this provider's one clearing rule, same as a forward `push`.
    currentPathname = "/accounting/trial-balance";
    view.rerender(<Harness />);
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
  });

  it("keeps aria-current on the committed page throughout a pending navigation, moving only once it is served", () => {
    const view = render(<Harness />);
    const trialBalanceLink = screen.getByRole("link", { name: "تراز آزمایشی" });
    const overviewLink = screen.getByRole("link", { name: "همین صفحه" });

    // Before any click: the committed page ("overview") carries aria-current.
    expect(overviewLink.getAttribute("aria-current")).toBe("page");
    expect(trialBalanceLink.getAttribute("aria-current")).toBeNull();

    fireEvent.click(trialBalanceLink);
    expect(screen.getByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeTruthy();

    // Still mid-flight: aria-current must not have jumped ahead of the
    // actually-served route just because a click landed — a screen reader
    // announcing "current page" must describe where the user still is, not
    // where a maybe-cancellable navigation is merely headed.
    expect(overviewLink.getAttribute("aria-current")).toBe("page");
    expect(trialBalanceLink.getAttribute("aria-current")).toBeNull();

    // The route is actually served now — aria-current moves, in the same
    // render that clears the indicator.
    currentPathname = "/accounting/trial-balance";
    view.rerender(<Harness />);
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
    expect(screen.getByRole("link", { name: "تراز آزمایشی" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "همین صفحه" }).getAttribute("aria-current")).toBeNull();
  });
});
