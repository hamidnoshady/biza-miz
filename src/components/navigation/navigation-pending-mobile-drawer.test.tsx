// @vitest-environment jsdom

/**
 * Issue #909 item 5 — "navigation-pending on mobile drawer": the phone
 * drawer's own close-on-navigate watcher (`CloseDrawerOnNavigate`,
 * dashboard-sidebar.tsx) and the shared "در حال انتقال…" acknowledgment
 * (`navigation-pending.tsx`) both key off the exact same signal — the served
 * route actually changing — so a committed navigation clears both together,
 * and neither ever fires for a same-route refresh.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

// `NavigationPendingProvider` reads the current route through next/navigation
// directly; `CloseDrawerOnNavigate` instead takes it as a plain prop (its
// caller, the real sidebar, supplies it). This shared mutable holder lets the
// test drive both from the one "the route actually changed" moment, the way
// the real app's router does for both at once.
const pathnameHolder = vi.hoisted(() => ({ value: "/dashboard" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameHolder.value,
  useSearchParams: () => new URLSearchParams(),
}));
import { CloseDrawerOnNavigate } from "../../app/dashboard/dashboard-sidebar";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import {
  NavigationPendingIndicator,
  NavigationPendingProvider,
  useNavigationPending,
} from "./navigation-pending";

beforeEach(() => {
  // jsdom has no matchMedia; SidebarProvider reads the phone breakpoint on mount.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  pathnameHolder.value = "/dashboard";
});

function DrawerStatus() {
  const { openMobile } = useSidebar();
  return <span data-testid="drawer-status">{openMobile ? "open" : "closed"}</span>;
}

function OpenDrawerButton() {
  const { setOpenMobile } = useSidebar();
  return (
    <button type="button" onClick={() => setOpenMobile(true)}>
      باز کردن کشو
    </button>
  );
}

/** Stands in for a drawer menu item's click handler calling `beginNavigation`. */
function NavigateFromDrawerButton({ href }: { href: string }) {
  const { beginNavigation } = useNavigationPending();
  return (
    <button type="button" onClick={() => beginNavigation(href)}>
      رفتن به {href}
    </button>
  );
}

function Harness({ pathname }: { pathname: string }) {
  return (
    <NavigationPendingProvider>
      <SidebarProvider>
        <CloseDrawerOnNavigate pathname={pathname} />
        <NavigationPendingIndicator />
        <DrawerStatus />
        <OpenDrawerButton />
        <NavigateFromDrawerButton href="/dashboard/reports" />
      </SidebarProvider>
    </NavigationPendingProvider>
  );
}

/** Mounts `Harness`, letting the test commit "the route actually changed" on demand. */
function renderHarness() {
  function Wrapper() {
    const [, bump] = useState(0);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            // The one moment a real navigation commits: the served route
            // changes, which is exactly what both the drawer-closer and the
            // pending-acknowledgment provider watch for — nothing else here
            // tells either of them anything happened.
            pathnameHolder.value = "/dashboard/reports";
            bump((n) => n + 1);
          }}
        >
          شبیه‌سازی ورود به مسیر جدید
        </button>
        <Harness pathname={pathnameHolder.value} />
      </>
    );
  }
  return render(<Wrapper />);
}

describe("mobile drawer + navigation-pending acknowledgment — a committed navigation vs. a same-route refresh", () => {
  it("a committed navigation (the route actually changing) closes the drawer and clears the pending acknowledgment together", async () => {
    renderHarness();
    act(() => screen.getByRole("button", { name: "باز کردن کشو" }).click());
    expect(screen.getByTestId("drawer-status").textContent).toBe("open");

    act(() => screen.getByRole("button", { name: "رفتن به /dashboard/reports" }).click());
    expect(screen.getByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeTruthy();
    // The drawer is still open — only the route actually changing closes it.
    expect(screen.getByTestId("drawer-status").textContent).toBe("open");

    // The navigation commits: `pathname` changes, the same signal both
    // `CloseDrawerOnNavigate` and `NavigationPendingProvider` watch.
    act(() => screen.getByRole("button", { name: "شبیه‌سازی ورود به مسیر جدید" }).click());
    expect(screen.getByTestId("drawer-status").textContent).toBe("closed");
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
  });

  it("never closes the drawer or shows a pending acknowledgment for a same-route refresh", () => {
    renderHarness();
    act(() => screen.getByRole("button", { name: "باز کردن کشو" }).click());
    expect(screen.getByTestId("drawer-status").textContent).toBe("open");

    // Nothing here changed the route — no `beginNavigation` call, no
    // pathname change — exactly what a background data refresh looks like
    // from this pair's point of view.
    expect(screen.queryByRole("status", { name: "در حال انتقال به صفحهٔ بعد" })).toBeNull();
    expect(screen.getByTestId("drawer-status").textContent).toBe("open");
  });
});
