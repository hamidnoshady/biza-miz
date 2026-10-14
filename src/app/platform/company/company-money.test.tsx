// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MoneyProvider } from "@/components/money/money-context";
import { formatMoney, type MoneyUnit } from "@/lib/money";
import type {
  PlatformCompanyCustomerSummary,
  PlatformCompanyDealSummary,
  PlatformCompanyStatus,
} from "@/lib/platform-company-types";
import CrmPage from "./crm/page";
import WorkspacePage from "./workspace/page";

// Mount the real pages AND CompanyWorkspace/MoneyProvider. Mocking the shell
// would hide the original defect: useMoney in Page ran above its own provider.
const customer: PlatformCompanyCustomerSummary = {
  id: "customer-1",
  partyId: "party-1",
  legalName: "مشتری منتخب",
  billingCustomerKey: "customer-key",
  churnRisk: "low",
  accountOwner: null,
  tenants: [{
    tenantId: "tenant-1",
    tenantName: "کسب‌وکار مشتری",
    subscriptionStatus: "active",
    walletBalanceRial: 1_230_000,
    openInvoiceRial: 540_000,
    supportTickets: 0,
  }],
  accountingBalanceRial: 670_000,
  invoicedRial: 890_000,
  settledRial: 220_000,
  deals: [],
  projectCount: 0,
};

const deal: PlatformCompanyDealSummary = {
  id: "deal-1",
  title: "معاملهٔ منتخب",
  valueRial: 4_560_000,
  outcome: "won",
  stageName: "برنده",
  customerName: "مشتری معامله",
  closedAt: null,
  projectId: null,
  projectName: null,
  eligible: true,
  ineligibleReason: null,
};

const project = {
  id: "project-1",
  name: "پروژهٔ منتخب",
  status: "active",
  priority: "medium",
  projectType: "customer",
  partyName: "مشتری پروژه",
  startDate: null,
  endDate: null,
  budgetRial: 7_890_000,
  forecastRevenueRial: 9_870_000,
  sourceDealId: "deal-1",
  taskCount: 2,
  doneTaskCount: 1,
  memberCount: 1,
  links: [],
  postedActuals: { revenueRial: 6_540_000, costRial: 3_210_000 },
};

function mockCompanyApi(unit: MoneyUnit) {
  const status: PlatformCompanyStatus = {
    state: "ready",
    company: { businessId: "company-1", name: "شرکت آزمون", subdomain: "company", status: "active" },
    membership: { preset: "company_owner", active: true, revision: 1 },
    entitlements: ["workspace", "accounting", "crm", "growth", "websites"],
    moneyUnit: unit,
    canProvision: true,
    canAdministerMembers: true,
    provisioningSupported: true,
  };
  const bodies: Record<string, unknown> = {
    "/api/platform/company/status": { company: status },
    "/api/platform/company/crm/customers": { customers: [customer] },
    "/api/platform/company/crm/deals": { deals: [deal] },
    "/api/platform/company/workspace/projects": { projects: [project], actualsIncluded: true },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!(url in bodies)) throw new Error(`Unexpected company request: ${url}`);
    return Response.json(bodies[url]);
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(["rial", "toman"] as const)("company money display: %s", (unit) => {
  // An opposite outer unit also proves the company provider, rather than an
  // unrelated ancestor or the context default, controls these pages.
  const outerUnit = unit === "rial" ? "toman" : "rial";

  it("formats CRM balances, wallet amounts, open invoices and deal values in the company unit", async () => {
    mockCompanyApi(unit);
    render(<MoneyProvider unit={outerUnit}><CrmPage /></MoneyProvider>);

    const customerRow = (await screen.findByText(customer.legalName)).closest("tr")!;
    for (const amount of [1_230_000, 540_000, 670_000, 890_000, 220_000]) {
      expect(customerRow.textContent).toContain(formatMoney(amount, unit));
      expect(customerRow.textContent).not.toContain(formatMoney(amount, outerUnit));
    }
    const dealRow = (await screen.findByText(deal.title)).closest("tr")!;
    expect(dealRow.textContent).toContain(formatMoney(deal.valueRial, unit));
    expect(dealRow.textContent).not.toContain(formatMoney(deal.valueRial, outerUnit));
  });

  it("formats project budgets, forecasts and posted actuals in the company unit", async () => {
    mockCompanyApi(unit);
    render(<MoneyProvider unit={outerUnit}><WorkspacePage /></MoneyProvider>);

    const row = (await screen.findByText(project.name)).closest("tr")!;
    for (const amount of [7_890_000, 9_870_000, 6_540_000, 3_210_000]) {
      expect(row.textContent).toContain(formatMoney(amount, unit));
      expect(row.textContent).not.toContain(formatMoney(amount, outerUnit));
    }
  });
});
