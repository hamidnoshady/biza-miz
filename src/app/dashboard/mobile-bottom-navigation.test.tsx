// @vitest-environment jsdom
/**
 * The phone's bottom bar, mounted, with the glyph it actually draws.
 *
 * The regression this guards: the bar looked up `NAV_ICONS[item.href]`, and
 * «فضای کار حسابداری» (and every ledger tool) has no href key in that map, so a
 * pinned ledger tab drew the generic circle while the sidebar drew the
 * calculator. Asserting the rendered SVG — not a map entry — is what catches a
 * future href that the bar reaches but the map does not.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MobileBottomNavigation, type NavItem } from "./dashboard-sidebar";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const ACCOUNTING_NAV: NavItem[] = [
  {
    label: "حسابداری",
    href: "/accounting/overview",
    children: [
      { label: "فضای کار حسابداری", href: "/accounting/ledger" },
      { label: "دریافتنی‌ها", href: "/accounting/receivables" },
      { label: "سفارش‌ها", href: "/accounting/orders" },
    ],
  } as NavItem,
];

function barLink(container: HTMLElement, href: string): HTMLElement {
  const nav = within(container).getByRole("navigation", { name: "ناوبری اصلی" });
  const link = nav.querySelector(`a[href="${href}"]`);
  if (!(link instanceof HTMLElement)) throw new Error(`no bottom-bar link for ${href}`);
  return link;
}

function glyphOf(link: HTMLElement): string | null {
  const svg = link.querySelector("svg");
  return svg?.getAttribute("class") ?? null;
}

describe("mobile bottom bar glyphs", () => {
  it("draws the calculator for a pinned «فضای کار حسابداری» tab, not the generic circle", () => {
    const { container } = render(
      <MobileBottomNavigation
        navItems={ACCOUNTING_NAV}
        pathname="/accounting/ledger"
        hrefs={["/accounting/ledger", "/accounting/orders"]}
      />,
    );
    const ledger = barLink(container, "/accounting/ledger");
    expect(glyphOf(ledger)).toContain("lucide-calculator");
    expect(glyphOf(ledger)).not.toContain("lucide-circle");
    expect(ledger.getAttribute("aria-current")).toBe("page");
  });

  it("draws the same glyph a pinned ledger tool wears in the sidebar", () => {
    const { container } = render(
      <MobileBottomNavigation
        navItems={ACCOUNTING_NAV}
        pathname="/accounting/receivables"
        hrefs={["/accounting/receivables"]}
      />,
    );
    const receivables = barLink(container, "/accounting/receivables");
    // The section map gives receivables the users glyph; the bar must agree.
    expect(glyphOf(receivables)).toContain("lucide-users");
    expect(glyphOf(receivables)).not.toContain("lucide-circle");
  });
});
