/**
 * Issue #1239 / ESH-90 — the first-run gallery's pure contract plus the one
 * invariant that matters most: **saving a selection must not debit the wallet**.
 *
 * The DB half is exercised with mocked collaborators so the test can assert
 * both what was written (one settings row) and what was not (no activation, no
 * wallet insert, no money).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APPS } from "./apps";
import { SETTING_KEYS } from "./settings";
import {
  buildSetupAppCard,
  normalizeSelectedApps,
  selectionRecord,
  setupAppPricing,
  setupAppTotals,
  setupStepRequired,
  type SetupAppCard,
} from "./setup-apps";
import type { ServiceTariff } from "./service-activation/catalog";

const dbQuery = vi.fn();
vi.mock("./db", () => ({
  query: (...args: unknown[]) => dbQuery(...args),
  withTenant: (_businessId: string, work: () => unknown) => work(),
}));
vi.mock("./industry-guard", () => ({ getBusinessIndustry: vi.fn(async () => "food_service") }));
vi.mock("./deployment-mode", () => ({
  readDeploymentProfile: vi.fn(async () => ({ profile: "cloud", pairedAt: null, source: "profile" })),
}));
vi.mock("./app-availability-service", () => ({
  effectiveAppAvailability: vi.fn(async () => ({})),
}));
vi.mock("./settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings")>();
  return { ...actual, getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => {}) };
});
vi.mock("./service-activation/pricing-service", () => ({
  serviceTariffAt: vi.fn(async () => ({
    version: 1,
    setupMode: "hour_equivalent",
    setupFixedRial: 0,
    setupEquivalentHours: 168,
    hourlyRateRial: 1_000,
    published: true,
  })),
}));
vi.mock("./service-activation/activation-service", () => ({
  listBusinessServiceActivations: vi.fn(async () => []),
  getServiceWizardState: vi.fn(async () => null),
  activateService: vi.fn(),
}));

import * as settings from "./settings";
import * as activation from "./service-activation/activation-service";
import { saveSelectedSetupApps } from "./setup-apps-service";

const tariff: ServiceTariff = {
  version: 3,
  setupMode: "hour_equivalent",
  setupFixedRial: 0,
  setupEquivalentHours: 168,
  hourlyRateRial: 120_000,
  published: true,
};

function card(overrides: Partial<SetupAppCard>): SetupAppCard {
  return {
    key: "accounting",
    label: "حسابداری",
    description: "",
    features: [],
    compatible: true,
    available: true,
    selectable: true,
    unavailableReason: null,
    pricing: {
      version: 1,
      setupRial: 1_000,
      hourlyRial: 100,
      estimated24hRial: 2_400,
    },
    selected: true,
    hasSetupProgress: false,
    setupComplete: false,
    nextStep: "fiscal",
    activation: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbQuery.mockResolvedValue({ rows: [{ balance_rial: "0" }] });
  vi.mocked(settings.getSetting).mockResolvedValue(null);
});

describe("selection normalisation", () => {
  it("keeps canonical apps only, deduplicated and in registry order", () => {
    expect(
      normalizeSelectedApps({
        apps: ["website", "not-an-app", "accounting", "website"],
      }),
    ).toEqual(["accounting", "website"]);
    expect(normalizeSelectedApps("nonsense")).toEqual([]);
    expect(selectionRecord(["crm"]).apps).toEqual(["crm"]);
  });
});

describe("pricing", () => {
  it("derives the setup fee from the published tariff and daily from 24 hours", () => {
    const pricing = setupAppPricing(tariff);
    // 168h × 120,000 = 20,160,000 Rial setup; 24h = 2,880,000 Rial.
    expect(pricing?.setupRial).toBe(20_160_000);
    expect(pricing?.estimated24hRial).toBe(2_880_000);
    expect(pricing?.hourlyRial).toBe(120_000);
  });

  it("treats an unpublished or absent tariff as unavailable, never free", () => {
    expect(setupAppPricing(null)).toBeNull();
    expect(setupAppPricing({ ...tariff, published: false })).toBeNull();
  });
});

describe("eligibility and totals", () => {
  it("marks deployment/tariff/availability reasons and enables only a priced, supported app", () => {
    const growth = APPS.find((app) => app.key === "growth")!;
    expect(
      buildSetupAppCard({
        app: growth,
        industry: "food_service",
        deploymentProfile: "local",
        available: true,
        pricing: setupAppPricing(tariff),
        selected: false,
      }).unavailableReason,
    ).toBe("deployment");

    expect(
      buildSetupAppCard({
        app: growth,
        industry: "food_service",
        deploymentProfile: "cloud",
        available: false,
        pricing: setupAppPricing(tariff),
        selected: false,
      }).selectable,
    ).toBe(false);

    const selectable = buildSetupAppCard({
      app: growth,
      industry: "food_service",
      deploymentProfile: "cloud",
      available: true,
      pricing: setupAppPricing(tariff),
      selected: true,
    });
    expect(selectable.selectable).toBe(true);
    expect(selectable.features.length).toBeGreaterThanOrEqual(2);
  });

  it("sums only selected cards that carry a price", () => {
    const totals = setupAppTotals([
      card({ key: "accounting" }),
      card({ key: "crm", pricing: null }),
      card({ key: "growth", selected: false }),
    ]);
    expect(totals).toEqual({ setupRial: 1_000, estimated24hRial: 2_400 });
  });

  it("maps accounting-owned setup steps to the Accounting app, and keeps legacy selection open", () => {
    for (const step of ["accounts", "costing", "tax", "menu"]) {
      expect(setupStepRequired(step, ["accounting"]), step).toBe(true);
      expect(setupStepRequired(step, []), step).toBe(false);
      expect(setupStepRequired(step, null), step).toBe(true);
    }
    expect(setupStepRequired("users", [])).toBe(true);
  });
});

describe("saving a selection is a draft, not a purchase", () => {
  it("writes one settings row and never activates or writes the wallet", async () => {
    const result = await saveSelectedSetupApps("biz-1", ["accounting"]);

    expect(result).toEqual({ ok: true, selected: ["accounting"] });
    expect(settings.setSetting).toHaveBeenCalledTimes(1);
    expect(settings.setSetting).toHaveBeenCalledWith(
      "biz-1",
      SETTING_KEYS.setupSelectedApps,
      expect.objectContaining({ apps: ["accounting"] }),
    );

    // The only wallet-related SQL may be the read-only balance SELECT.
    for (const call of dbQuery.mock.calls) {
      const sql = String(call[0] ?? "");
      if (sql.includes("business_wallets")) {
        expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
      }
    }
    expect(activation.activateService).not.toHaveBeenCalled();
  });

  it("refuses an app that the published catalogue does not offer", async () => {
    const pricing = await import("./service-activation/pricing-service");
    vi.mocked(pricing.serviceTariffAt).mockResolvedValueOnce(null as never);

    const result = await saveSelectedSetupApps("biz-1", ["accounting"]);
    expect(result).toEqual({ ok: false, error: "invalid_app" });
    expect(settings.setSetting).not.toHaveBeenCalled();
    expect(activation.activateService).not.toHaveBeenCalled();
  });
});
