import { describe, expect, it } from "vitest";
import { INDUSTRIES } from "./industries";
import { coaTemplateForIndustry } from "./coa-template";
import { industryProfile } from "./industry-profile";
import {
  computeServiceSalePrice,
  defaultServiceRevenueCode,
  isServiceInvoiceIndustry,
  normalizeServiceDescription,
  resolveServiceRevenueCode,
  SERVICE_DESCRIPTION_MAX_LENGTH,
  SERVICE_INVOICE_INDUSTRIES,
  SERVICE_REVENUE_ACCOUNTS,
} from "./service-invoice";

describe("service invoice trades", () => {
  it("are exactly the three trades that bill described services", () => {
    // A service company, issue #799's engineering/contracting trade and issue
    // #1128's advertising agency: the three that sell work rather than goods.
    expect([...SERVICE_INVOICE_INDUSTRIES].sort()).toEqual([
      "advertising_agency",
      "architecture_construction",
      "service_saas",
    ]);
    for (const industry of INDUSTRIES) {
      expect(isServiceInvoiceIndustry(industry), industry).toBe(
        industry === "service_saas" ||
          industry === "architecture_construction" ||
          industry === "advertising_agency",
      );
    }
  });

  it("bill from the invoice screen and hold no stock", () => {
    for (const industry of SERVICE_INVOICE_INDUSTRIES) {
      const profile = industryProfile(industry);
      expect(profile.salesModel, industry).toBe("retail_invoice");
      expect(profile.modules, industry).toContain("pos");
      expect(profile.modules, industry).not.toContain("stock");
    }
  });

  it("only credit revenue accounts that the trade's chart seeds", () => {
    for (const industry of SERVICE_INVOICE_INDUSTRIES) {
      const chart = new Map(coaTemplateForIndustry(industry).map((account) => [account.code, account]));
      for (const account of SERVICE_REVENUE_ACCOUNTS[industry]) {
        expect(chart.get(account.code)?.type, `${industry}/${account.code}`).toBe("revenue");
      }
    }
  });
});

describe("service revenue account", () => {
  it("defaults to the first account of the trade", () => {
    expect(defaultServiceRevenueCode("architecture_construction")).toBe("4610");
    expect(defaultServiceRevenueCode("service_saas")).toBe("4500");
    // Issue #1128 — the agency's default is the account its posting rules and
    // its chart already name for a service sale: 4640, campaign management.
    expect(defaultServiceRevenueCode("advertising_agency")).toBe("4640");
    expect(resolveServiceRevenueCode("architecture_construction", undefined)).toBe("4610");
    expect(resolveServiceRevenueCode("architecture_construction", "")).toBe("4610");
    expect(resolveServiceRevenueCode("advertising_agency", null)).toBe("4640");
  });

  it("accepts the supervision and construction accounts for an engineering firm", () => {
    expect(resolveServiceRevenueCode("architecture_construction", "4620")).toBe("4620");
    expect(resolveServiceRevenueCode("architecture_construction", "4630")).toBe("4630");
  });

  it("accepts the agency's four revenue accounts, and only those", () => {
    // §D's split, made a ledger fact at the moment of invoicing: creative work,
    // media and PR/events each credit their own account, so a campaign P&L can
    // read agency fees apart from a media recharge instead of guessing from the
    // size of a line.
    expect(resolveServiceRevenueCode("advertising_agency", "4650")).toBe("4650");
    expect(resolveServiceRevenueCode("advertising_agency", "4660")).toBe("4660");
    expect(resolveServiceRevenueCode("advertising_agency", "4670")).toBe("4670");
    expect(SERVICE_REVENUE_ACCOUNTS.advertising_agency.map((account) => account.code)).toEqual([
      "4640",
      "4650",
      "4660",
      "4670",
    ]);
    // The agency's own marketing (5600) and its direct client cost (5196–5199)
    // are not revenue accounts and must never be offered as one.
    for (const code of ["5600", "5196", "5197", "2430", "1270"]) {
      expect(() => resolveServiceRevenueCode("advertising_agency", code), code).toThrow();
    }
  });

  it("refuses another trade's account rather than crediting a different one", () => {
    expect(() => resolveServiceRevenueCode("architecture_construction", "4500")).toThrow();
    expect(() => resolveServiceRevenueCode("service_saas", "4610")).toThrow();
    expect(() => resolveServiceRevenueCode("service_saas", "9999")).toThrow();
    expect(() => resolveServiceRevenueCode("advertising_agency", "4610")).toThrow();
    expect(() => resolveServiceRevenueCode("architecture_construction", "4640")).toThrow();
  });
});

describe("service description", () => {
  it("is trimmed and required", () => {
    expect(normalizeServiceDescription("  طراحی نقشه  ")).toBe("طراحی نقشه");
    expect(() => normalizeServiceDescription("   ")).toThrow();
    expect(() => normalizeServiceDescription(undefined)).toThrow();
    expect(() => normalizeServiceDescription(42)).toThrow();
  });

  it("is bounded", () => {
    expect(normalizeServiceDescription("x".repeat(SERVICE_DESCRIPTION_MAX_LENGTH))).toHaveLength(SERVICE_DESCRIPTION_MAX_LENGTH);
    expect(() => normalizeServiceDescription("x".repeat(SERVICE_DESCRIPTION_MAX_LENGTH + 1))).toThrow();
  });
});

describe("computeServiceSalePrice", () => {
  it("prices quantity × unit price, less discount, plus VAT, in whole Rial", () => {
    // 3 × 10,000,000 = 30,000,000; discount 2,000,000 → net 28,000,000;
    // 10% VAT = 2,800,000; total 30,800,000.
    const price = computeServiceSalePrice({ unitPrice: 10_000_000, quantity: "3", discount: 2_000_000, vatPercent: 10 });
    expect(price).toEqual({
      gross: "30000000",
      discount: "2000000",
      net: "28000000",
      vat: "2800000",
      total: "30800000",
    });
  });

  it("allows a zero VAT rate", () => {
    const price = computeServiceSalePrice({ unitPrice: 5_000_000, quantity: "1", vatPercent: 0 });
    expect(price.vat).toBe("0");
    expect(price.total).toBe("5000000");
  });

  it("refuses a discount larger than the line, a zero quantity and a zero price", () => {
    expect(() => computeServiceSalePrice({ unitPrice: 1_000, quantity: "1", discount: 2_000, vatPercent: 0 })).toThrow();
    expect(() => computeServiceSalePrice({ unitPrice: 1_000, quantity: "0", vatPercent: 0 })).toThrow();
    expect(() => computeServiceSalePrice({ unitPrice: 0, quantity: "1", vatPercent: 0 })).toThrow();
  });
});
