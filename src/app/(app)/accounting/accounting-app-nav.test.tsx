// @vitest-environment jsdom
/**
 * The Accounting sidebar, mounted.
 *
 * What cannot be proven by calling `accountingWorkspaceGroups()` is what the
 * requirement is actually about: that «فضای کار حسابداری» renders as ONE
 * ordinary menu link — the same `SidebarMenuButton`/`Link` row as «فروش و
 * فاکتور» — with no disclosure button, no chevron, no nested panel, and no
 * open/closed state. The old bug lived in the JSX (a `NavCollapsibleGroup`
 * with `aria-expanded` and a remembered `localStorage` state), so the
 * regression tests live in the JSX too.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar";
import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import { roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import { AccountingAppNav } from "./accounting-app-nav";

// A plain anchor is enough — the contract under test is the menu's markup and
// its click wiring, not the Next router.
vi.mock("next/link", () => ({
  default: ({ href, onClick, children, ...props }: { href: string; onClick?: () => void; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

const SHELL = {
  app: "accounting",
  prefix: "/accounting",
  label: "حسابداری",
  description: "حسابداری",
} as AppShellNavProps["shell"];

function permissionsOf(role: Role | "none"): string[] {
  return role === "none" ? [] : [...roleBasePermissions(role)];
}

function renderNav({
  role = "owner",
  pathname = "/accounting/ledger",
  onNavigate = vi.fn(),
  collapsed = false,
  navItems = [],
}: {
  role?: Role | "none";
  pathname?: string;
  onNavigate?: () => void;
  collapsed?: boolean;
  navItems?: readonly { label: string; href: string; iconKey?: string }[];
} = {}) {
  return render(
    <SidebarProvider open={!collapsed}>
      <Sidebar>
        <AccountingAppNav
          shell={SHELL}
          role={role === "none" ? "cashier" : role}
          permissions={permissionsOf(role)}
          pathname={pathname}
          search=""
          navItems={navItems}
          onNavigate={onNavigate}
        />
      </Sidebar>
    </SidebarProvider>,
  );
}

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
  vi.restoreAllMocks();
});

describe("AccountingAppNav — «فضای کار حسابداری» is one ordinary link", () => {
  it("renders exactly one workspace link, labelled exactly, at the canonical href", () => {
    renderNav();
    const links = screen.getAllByRole("link", { name: "فضای کار حسابداری" });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/accounting/ledger");
    // The label lives on the row in the shared label skin — not on a heading
    // above it, and not only in a tooltip.
    const label = links[0].querySelector("span");
    expect(label?.className).toContain("group-data-[state=collapsed]/sidebar:hidden");
    expect(label?.className).toContain("truncate");
    // It wears a 20px glyph (the accounting calculator mapping), like every
    // ordinary row — `size-5`, aria-hidden, never a bespoke disclosure slot.
    const icon = links[0].querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("class")).toContain("size-5");
  });

  it("has no disclosure button, chevron or nested sidebar panel", () => {
    const { container } = renderNav();
    // Nothing in the menu is a button at all: every row is a real link. The
    // old ledger group was a `<button aria-expanded aria-controls>` over a
    // panel div — none of that may come back.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector("[aria-expanded]")).toBeNull();
    expect(container.querySelector("[aria-controls]")).toBeNull();
    // The workspace page lists the tools now; the sidebar does not nest them.
    for (const tool of [
      "/accounting/trial-balance",
      "/accounting/entries",
      "/accounting/payroll",
    ]) {
      expect(container.querySelector(`a[href="${tool}"]`)).toBeNull();
    }
  });

  it("lights the workspace row on its landing page and its owned tool routes", () => {
    for (const path of ["/accounting/ledger", "/accounting/trial-balance", "/accounting/payroll"]) {
      renderNav({ pathname: path });
      const link = screen.getByRole("link", { name: "فضای کار حسابداری" });
      expect(link.getAttribute("aria-current"), `row must light on ${path}`).toBe("page");
      expect(link.closest("[data-slot='sidebar-menu-button']")?.getAttribute("data-active")).toBe("true");
      cleanup();
    }
  });

  it("keeps the workspace row unlit on unrelated Accounting areas", () => {
    for (const path of [
      "/accounting/overview",
      "/accounting/directory",
      "/accounting/orders",
      "/accounting/pos",
    ]) {
      renderNav({ pathname: path });
      const link = screen.getByRole("link", { name: "فضای کار حسابداری" });
      expect(link.getAttribute("aria-current"), `row must stay dark on ${path}`).toBeNull();
      expect(link.closest("[data-slot='sidebar-menu-button']")?.getAttribute("data-active")).toBeNull();
      cleanup();
    }
  });

  it("closes the mobile drawer through onNavigate when the row is tapped", () => {
    const onNavigate = vi.fn();
    renderNav({ onNavigate });
    fireEvent.click(screen.getByRole("link", { name: "فضای کار حسابداری" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("keeps every row reachable at the icon rail, with the label hidden and a tooltip", () => {
    renderNav({ collapsed: true });
    const link = screen.getByRole("link", { name: "فضای کار حسابداری" });
    // Still a link at 4rem — an icon rail must never hide a destination.
    expect(link.getAttribute("href")).toBe("/accounting/ledger");
    // The label hides with the shared collapse rule (CSS), and the row is
    // wired as a tooltip trigger so the icon keeps its name at the rail —
    // exactly the `SidebarMenuButton tooltip={entry.label}` contract every
    // other row wears.
    expect(link.querySelector("span")?.className).toContain("group-data-[state=collapsed]/sidebar:hidden");
    expect(link.getAttribute("data-state")).toBe("closed");
  });

  it("shows the workspace link only to members the section gate lets in", () => {
    renderNav({ role: "cashier" });
    expect(screen.queryByRole("link", { name: "فضای کار حسابداری" })).toBeNull();
    cleanup();
    renderNav({ role: "manager" });
    expect(
      screen.getByRole("link", { name: "فضای کار حسابداری" }).getAttribute("href"),
    ).toBe("/accounting/ledger");
  });
});

describe("AccountingAppNav — the rest of the menu is unchanged", () => {
  it("adopts business rows the shell already granted, in their groups", () => {
    renderNav({
      navItems: [{ label: "فروش و فاکتور", href: "/accounting/pos", iconKey: "/accounting/pos" }],
    });
    const sell = screen.getByRole("link", { name: "فروش و فاکتور" });
    expect(sell.getAttribute("href")).toBe("/accounting/pos");
    // The same row skin the workspace link wears — one spelling of a menu row.
    expect(sell.closest("[data-slot='sidebar-menu-button']")?.className).toContain(
      "rounded-xl",
    );
  });

  it("keeps «بازگشت به میز کار» first and the menu named for screen readers", () => {
    const { container } = renderNav();
    expect(screen.getByRole("link", { name: /بازگشت به میز کار/ }).getAttribute("href")).toBe(
      "/dashboard",
    );
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("منوی حسابداری");
  });
});
