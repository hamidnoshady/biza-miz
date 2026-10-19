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
});

function Harness({ dirty, onChip }: { dirty?: boolean; onChip?: () => void } = {}) {
  const guard = useUnsavedChangesGuard(dirty ?? false);
  return (
    <AppRouterContext.Provider value={router as never}>
      <NavigationPendingProvider>
        <NavigationPendingIndicator />
        <nav>
          <Link href="/accounting/trial-balance">تراز آزمایشی</Link>
          <Link href="/accounting/overview">همین صفحه</Link>
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
});
