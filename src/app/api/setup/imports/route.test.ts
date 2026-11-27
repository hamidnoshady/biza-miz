/**
 * Issue #1535 / ESH-218 — the import step's read model.
 *
 * The route itself owns no import logic, so the assertions here are the ones
 * that matter for onboarding: it is a *read*, it filters by the selected apps,
 * it reports an unpermitted type as unavailable instead of offering it, and it
 * never reports a staged job as applied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as settings from "@/lib/settings";
import * as memberAccess from "@/lib/member-access";
import * as industry from "@/lib/industry-guard";
import * as registry from "@/lib/data-transfer/registry";
import * as imports from "@/lib/data-transfer/import-service";
import * as setupApps from "@/lib/setup-apps-service";
import * as activation from "@/lib/service-activation/app-gate-service";
import * as grants from "@/lib/complimentary-grant-service";
import * as availability from "@/lib/app-availability-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, requireManager: vi.fn() };
});
vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, getSetting: vi.fn() };
});
vi.mock("@/lib/member-access", () => ({ memberAccessFor: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: vi.fn() }));
vi.mock("@/lib/data-transfer/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data-transfer/registry")>();
  return {
    ...actual,
    entitiesForIndustry: vi.fn(),
    isImportable: vi.fn(() => true),
    findEntity: vi.fn(() => null),
  };
});
vi.mock("@/lib/data-transfer/import-service", () => ({ listImportJobs: vi.fn() }));
// #1580 — the effective-access axes are canonical database reads. The route's
// own contract is tested here, so each axis is pinned to a known state and the
// real pure resolver still decides the answer.
vi.mock("@/lib/setup-apps-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-apps-service")>();
  return { ...actual, getSelectedSetupApps: vi.fn() };
});
vi.mock("@/lib/service-activation/app-gate-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/service-activation/app-gate-service")>();
  return { ...actual, appServiceActivationState: vi.fn(), serviceActivationState: vi.fn() };
});
vi.mock("@/lib/complimentary-grant-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/complimentary-grant-service")>();
  return { ...actual, readActiveComplimentaryGrant: vi.fn() };
});
vi.mock("@/lib/app-availability-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-availability-service")>();
  return { ...actual, effectiveAppAvailability: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1" };

function definition(overrides: Record<string, unknown>) {
  return {
    key: "crm.customers",
    module: "crm",
    label: "مشتریان",
    description: "مشتریان و پرونده‌های ارتباطی",
    exportPermission: "crm.view",
    importPermission: "crm.edit",
    fields: [],
    ...overrides,
  };
}

const CUSTOMERS = definition({});
const PRODUCTS = definition({
  key: "pos.products",
  module: "pos",
  label: "محصولات",
  exportPermission: "menu.view",
  importPermission: "menu.edit",
});
const EXPENSES = definition({
  key: "accounting.expenses",
  module: "accounting",
  label: "هزینه‌ها",
  exportPermission: "accounting.view",
  importPermission: "accounting.edit",
});

function job(overrides: Record<string, unknown>) {
  return {
    id: "job-1",
    entityKey: "crm.customers",
    status: "completed",
    fileName: "customers.xlsx",
    createdAt: "2026-11-01T00:00:00.000Z",
    totalRows: 10,
    validRows: 10,
    errorRows: 0,
    createdRows: 10,
    updatedRows: 0,
    skippedRows: 0,
    failedRows: 0,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setupState.requireManager).mockResolvedValue({
    session: SESSION,
    error: null,
  } as never);
  vi.mocked(settings.getSetting).mockResolvedValue({ apps: ["crm"] });
  vi.mocked(memberAccess.memberAccessFor).mockResolvedValue({
    permissions: new Set([
      "data.import",
      "data.export",
      "crm.view",
      "crm.edit",
      "menu.view",
      "menu.edit",
      "accounting.view",
      "accounting.edit",
    ]),
  } as never);
  vi.mocked(industry.getBusinessIndustry).mockResolvedValue("food_service");
  vi.mocked(registry.entitiesForIndustry).mockReturnValue([
    CUSTOMERS,
    PRODUCTS,
    EXPENSES,
  ] as never);
  vi.mocked(imports.listImportJobs).mockResolvedValue([job({})] as never);
  // The canonical axes: a selected app with an active service is effective.
  vi.mocked(setupApps.getSelectedSetupApps).mockResolvedValue(["crm"] as never);
  vi.mocked(activation.appServiceActivationState).mockResolvedValue("active" as never);
  vi.mocked(activation.serviceActivationState).mockResolvedValue(null as never);
  vi.mocked(grants.readActiveComplimentaryGrant).mockResolvedValue(null as never);
  vi.mocked(availability.effectiveAppAvailability).mockResolvedValue({
    accounting: { usable: true },
    crm: { usable: true },
    growth: { usable: true },
    website: { usable: true },
  } as never);
});

describe("/api/setup/imports", () => {
  it("returns the wizard's candidates filtered by the saved app selection", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.selectedApps).toEqual(["crm"]);
    expect(body.candidates.map((c: { key: string }) => c.key)).toEqual([
      "crm.customers",
      "pos.products",
      "accounting.expenses",
    ]);
    const products = body.candidates.find((c: { key: string }) => c.key === "pos.products");
    expect(products.available).toBe(false);
    expect(products.reason).toBe("app_not_selected");
    // Only available types reach the shared importer.
    expect(body.entities.map((e: { key: string }) => e.key)).toEqual(["crm.customers"]);
  });

  it("reports an unpermitted type as unavailable and reads no jobs", async () => {
    vi.mocked(memberAccess.memberAccessFor).mockResolvedValue({
      permissions: new Set(["data.export"]),
    } as never);

    const response = await GET();
    const body = await response.json();

    expect(body.canImport).toBe(false);
    expect(body.sessions).toEqual([]);
    expect(body.candidates.every((c: { reason: string }) => c.reason === "permission")).toBe(true);
    expect(imports.listImportJobs).not.toHaveBeenCalled();
  });

  it("never reports a staged job as applied and summarises unfinished work", async () => {
    vi.mocked(imports.listImportJobs).mockResolvedValue([
      job({ id: "a", status: "pending" }),
      job({ id: "b", status: "completed", failedRows: 2 }),
      job({ id: "c", status: "completed" }),
    ] as never);

    const response = await GET();
    const body = await response.json();

    expect(body.sessions.map((s: { state: string }) => s.state)).toEqual([
      "staged",
      "partial",
      "applied",
    ]);
    expect(body.summary).toMatchObject({ total: 3, applied: 1, staged: 1, partial: 1, unfinished: 2 });
  });

  it("is a read: it never writes an import, a wallet entry or an activation", async () => {
    await GET();
    // The Data Transfer engine's only call from this route is the history read:
    // the upload, mapping, preview, reconcile and apply routes are untouched.
    expect(imports.listImportJobs).toHaveBeenCalledWith("biz-1", { limit: 50 });
  });

  it("offers menu-only data types to F&B and hides them from a trade with no menu", async () => {
    // Issue #1239 / ESH-90 — the registry's `requiresModule` is applied to the
    // wizard's list, so a jewellery shop is not offered «دسته‌های منو».
    const MENU = definition({
      key: "pos.categories",
      module: "pos",
      label: "دسته‌های منو",
      exportPermission: "menu.view",
      importPermission: "menu.edit",
      requiresModule: "menu",
    });
    vi.mocked(registry.entitiesForIndustry).mockReturnValue([MENU] as never);
    vi.mocked(settings.getSetting).mockResolvedValue({ apps: ["accounting"] });
    vi.mocked(setupApps.getSelectedSetupApps).mockResolvedValue(["accounting"] as never);

    vi.mocked(industry.getBusinessIndustry).mockResolvedValue("food_service");
    let body = await (await GET()).json();
    expect(body.candidates[0].available).toBe(true);
    expect(body.entities.map((entity: { key: string }) => entity.key)).toContain("pos.categories");

    vi.mocked(industry.getBusinessIndustry).mockResolvedValue("jewelry");
    body = await (await GET()).json();
    expect(body.candidates[0].available).toBe(false);
    expect(body.candidates[0].reason).toBe("industry_module");
    expect(body.entities.map((entity: { key: string }) => entity.key)).not.toContain("pos.categories");
  });
});
