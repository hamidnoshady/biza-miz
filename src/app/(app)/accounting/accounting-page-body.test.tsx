// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { effectivePermissions, PERMISSIONS, roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

/**
 * Issue #1124 — the Accounting app's home for a member without the ledger door.
 *
 * `/accounting/overview` is the landing for everyone admitted to the app. A
 * member holding `ledger.view` gets the ledger dashboard; one without it gets
 * a server-rendered page of shortcuts that mounts no ledger component and
 * reads no figure; one the app has nothing for gets an access explanation.
 * Nobody is bounced to the till.
 */
const m = vi.hoisted(() => ({
  session: vi.fn(),
  member: vi.fn(),
  features: vi.fn(),
  industry: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/auth", () => ({ getSession: m.session }));
vi.mock("@/lib/member-access", () => ({ memberAccessFor: m.member }));
vi.mock("@/lib/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features")>()),
  effectiveFeatures: m.features,
}));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: m.industry }));
vi.mock("@/lib/db", () => ({ withTenant: (_id: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/integrations/holoo/connection-service", () => ({ hasActiveHolooCompanion: async () => false }));
vi.mock("@/app/dashboard/knowledge-help", () => ({ KnowledgeHelpButton: () => null }));
vi.mock("@/components/ai/ask-assistant", () => ({ AskAssistant: () => null }));
vi.mock("./accounting-manager", () => ({
  AccountingManager: ({ section }: { section: string }) => <div data-testid="ledger-manager">{section}</div>,
}));

import { AccountingPageBody } from "./accounting-page-body";
import { AccountingStaffOverview } from "./accounting-staff-overview";

const allFeatures = new Proxy({} as Record<string, boolean>, { get: () => true });

function memberOf(role: Role, permissions: ReadonlySet<string> = new Set(roleBasePermissions(role))) {
  return { role, isActive: true, permissions };
}

async function renderBody(section: Parameters<typeof AccountingPageBody>[0]["section"]) {
  const page = await AccountingPageBody({ section });
  // React's client renderer cannot resolve an async server component, so the
  // staff overview is awaited the way the server would.
  if (page && typeof page === "object" && "type" in page && page.type === AccountingStaffOverview) {
    render(await AccountingStaffOverview(page.props as Parameters<typeof AccountingStaffOverview>[0]));
    return;
  }
  render(page);
}

beforeEach(() => {
  m.session.mockResolvedValue({ businessId: "b1", role: "cashier", sub: "u1" });
  m.features.mockResolvedValue(allFeatures);
  m.industry.mockResolvedValue("food_service");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("the staff overview must not fetch"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("/accounting/overview for staff without ledger.view", () => {
  it("renders the overview with a till shortcut instead of redirecting to the till", async () => {
    m.member.mockResolvedValue(memberOf("cashier"));
    await renderBody("dashboard");

    expect(m.redirect).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ledger-manager")).toBeNull();
    const pos = screen.getAllByRole("link").find((link) => link.getAttribute("href") === "/accounting/pos");
    expect(pos).toBeTruthy();
    // No bookkeeping destination is offered, and nothing was fetched.
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).not.toContain("/accounting/ledger");
    expect(hrefs).not.toContain("/accounting/trial-balance");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows a revoked operational permission", async () => {
    m.member.mockResolvedValue(
      memberOf("cashier", effectivePermissions("cashier", { revoked: [PERMISSIONS.paymentsTake] })),
    );
    await renderBody("dashboard");
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).not.toContain("/accounting/pos");
    expect(hrefs).toContain("/accounting/orders");
  });

  it("explains the policy, rather than redirecting, to a member the app has nothing for", async () => {
    m.member.mockResolvedValue(memberOf("cashier", new Set<string>()));
    await renderBody("dashboard");
    expect(m.redirect).not.toHaveBeenCalled();
    expect(screen.getByText("دسترسی به این برنامه ندارید")).toBeTruthy();
  });

  it("still sends a hand-typed ledger section back to the app root, not to the till", async () => {
    m.member.mockResolvedValue(memberOf("cashier"));
    await expect(AccountingPageBody({ section: "trial-balance" })).rejects.toThrow("REDIRECT:/accounting");
  });
});

describe("/accounting/overview for ledger-capable members", () => {
  it("keeps the ledger dashboard for a member holding ledger.view", async () => {
    m.session.mockResolvedValue({ businessId: "b1", role: "manager", sub: "u2" });
    m.member.mockResolvedValue(memberOf("manager"));
    await renderBody("dashboard");
    expect(screen.getByTestId("ledger-manager").textContent).toBe("dashboard");
  });

  it("grants the dashboard by permission, not by role name", async () => {
    m.member.mockResolvedValue(
      memberOf("cashier", effectivePermissions("cashier", { granted: [PERMISSIONS.ledgerView] })),
    );
    await renderBody("dashboard");
    expect(screen.getByTestId("ledger-manager")).toBeTruthy();
  });

  it("falls back to the operational overview when the ledger feature is off", async () => {
    m.session.mockResolvedValue({ businessId: "b1", role: "owner", sub: "u3" });
    m.member.mockResolvedValue(memberOf("owner"));
    m.features.mockResolvedValue(new Proxy({} as Record<string, boolean>, { get: (_t, key) => key !== "ledger" }));
    await renderBody("dashboard");
    expect(m.redirect).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ledger-manager")).toBeNull();
  });
});
