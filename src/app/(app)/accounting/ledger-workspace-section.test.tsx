// @vitest-environment jsdom
/**
 * The «فضای کار حسابداری» landing page, mounted.
 *
 * The rules this pins: every permitted ledger tool is reachable from this page
 * at its canonical route (the sidebar disclosure is gone, so this page is the
 * only place the tools gather), the tools are arranged under the accountant's
 * own four divisions, and a member without `payroll.view` sees no payroll —
 * the same `accountingSectionsFor` gate the section's route enforces.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import { accountingSectionHref, type AccountingSectionKey } from "./accounting-routes";
import { LEDGER_WORKSPACE_LABEL } from "./accounting-nav";
import {
  LEDGER_WORKSPACE_SECTION_KEYS,
  LEDGER_WORKSPACE_SUBGROUPS,
} from "./accounting-workspace";
import { LedgerWorkspaceSection } from "./ledger-workspace-section";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

function of(role: Role | "none"): ReadonlySet<string> {
  return new Set<string>(role === "none" ? [] : roleBasePermissions(role));
}

function hrefsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

describe("LedgerWorkspaceSection — the workspace page lists the permitted tools", () => {
  it("links every ledger tool at its canonical route, under its division", () => {
    const { container } = render(<LedgerWorkspaceSection permissions={of("owner")} />);
    const hrefs = hrefsIn(container);
    for (const key of LEDGER_WORKSPACE_SECTION_KEYS) {
      expect(hrefs, `«فضای کار حسابداری» must link ${key}`).toContain(accountingSectionHref(key));
    }
    // Every tool is a real link, arranged under the four divisions the
    // accountant's work divides into — the arrangement the sidebar disclosure
    // used to (badly) carry.
    for (const subGroup of LEDGER_WORKSPACE_SUBGROUPS) {
      expect(screen.getByRole("heading", { name: subGroup.label })).toBeTruthy();
    }
    // Exactly one link per tool — the page is an index, not a second ledger.
    expect(hrefs.length).toBe(LEDGER_WORKSPACE_SECTION_KEYS.length);
  });

  it("names each tool after its own section, not after the workspace", () => {
    render(<LedgerWorkspaceSection permissions={of("owner")} />);
    // The card titles are the sections' canonical labels («تراز آزمایشی» …),
    // while the workspace's own name belongs to the page header — this page is
    // an index of tools, and each card is one of them.
    expect(screen.getByRole("link", { name: /تراز آزمایشی/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /دفتر روزنامه/ })).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: new RegExp(`^${LEDGER_WORKSPACE_LABEL}$`) }),
    ).toBeNull();
  });

  it("hides payroll from a manager while keeping the rest — and does not dead-link it", () => {
    const { container } = render(<LedgerWorkspaceSection permissions={of("manager")} />);
    const hrefs = hrefsIn(container);
    expect(hrefs).not.toContain(accountingSectionHref("payroll"));
    expect(hrefs).toContain(accountingSectionHref("vat"));
    expect(hrefs).toContain(accountingSectionHref("trial-balance"));
    // The empty division is dropped rather than drawn as an empty heading.
    expect(screen.queryByRole("heading", { name: "دوره، مالیات و حقوق" })).toBeTruthy();
    expect(screen.queryByText(/حقوق و دستمزد/)).toBeNull();
  });

  it("shows the whole ledger to an accountant, payroll included", () => {
    const { container } = render(<LedgerWorkspaceSection permissions={of("accountant")} />);
    const hrefs = hrefsIn(container);
    expect(hrefs).toContain(accountingSectionHref("payroll"));
    for (const key of LEDGER_WORKSPACE_SECTION_KEYS as readonly AccountingSectionKey[]) {
      expect(hrefs).toContain(accountingSectionHref(key));
    }
  });

  it("degrades to an explanation, not a dead page, for a member with no tools", () => {
    render(<LedgerWorkspaceSection permissions={of("none")} />);
    expect(screen.getByText(/ابزاری برای نمایش نیست/)).toBeTruthy();
  });
});
