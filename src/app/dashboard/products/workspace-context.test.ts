import { beforeEach, describe, expect, it, vi } from "vitest";
import { automotiveCreateEntry, automotiveProductSectionForPage, specialistCreateEntry, specialistCatalogueForPage, specialistSectionForPage, requireProductWorkspace, requireRetailLabels } from "./workspace-context";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";

vi.mock("next/navigation", () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`); } }));
vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/member-access", () => ({ memberAccessFor: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));

describe("specialist catalogue entry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSession).mockResolvedValue({ businessId: "business" } as never);
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "owner", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.vehiclesView]) });
  });
  it.each(["jewelry", "watch", "automotive"] as const)("returns the native %s adapter for the shared list", async (industry) => {
    vi.mocked(getBusinessIndustry).mockResolvedValue(industry);
    await expect(specialistCatalogueForPage()).resolves.toEqual({ industry, canEdit: false });
  });
  it("gates specialist price and reports by the respective native API permissions", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("jewelry");
    await expect(specialistSectionForPage("prices")).resolves.toEqual({ industry: "jewelry", canEdit: false });
    await expect(specialistSectionForPage("reports")).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.reportsView]) });
    await expect(specialistSectionForPage("reports")).resolves.toEqual({ industry: "jewelry", canEdit: false });
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "owner", isActive: true, permissions: new Set([PERMISSIONS.inventoryView]) });
    vi.mocked(getBusinessIndustry).mockResolvedValue("watch");
    await expect(specialistSectionForPage("reports")).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.reportsView]) });
    await expect(specialistSectionForPage("reports")).resolves.toEqual({ industry: "watch", canEdit: false });
    await expect(specialistSectionForPage("prices")).resolves.toBeNull();
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: false, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.reportsView]) });
    await expect(specialistSectionForPage("reports")).rejects.toThrow("redirect:/accounting/overview");
  });
  it("requires both native vehicle permissions for the shared creation route", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("automotive");
    for (const permissions of [[], [PERMISSIONS.vehiclesView], [PERMISSIONS.vehiclesCreate]]) {
      vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set(permissions) });
      await expect(automotiveCreateEntry()).rejects.toThrow("redirect:/accounting/overview");
    }
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.vehiclesView, PERMISSIONS.vehiclesCreate]) });
    await expect(automotiveCreateEntry()).resolves.toBe(true);
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: false, permissions: new Set([PERMISSIONS.vehiclesView, PERMISSIONS.vehiclesCreate]) });
    await expect(automotiveCreateEntry()).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(getBusinessIndustry).mockResolvedValue("cosmetics");
    await expect(automotiveCreateEntry()).resolves.toBe(false);
  });
  it.each(["jewelry", "watch"] as const)("requires active inventory read/write and a resolved branch to create %s", async (industry) => {
    vi.mocked(getBusinessIndustry).mockResolvedValue(industry);
    vi.mocked(getSession).mockResolvedValue({ businessId: "business", sub: "member" } as never);
    vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "branch", name: "شعبهٔ مرکزی" } as never);
    for (const permissions of [[], [PERMISSIONS.inventoryView], [PERMISSIONS.inventoryAdjust]]) {
      vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set(permissions) });
      await expect(specialistCreateEntry()).rejects.toThrow("redirect:/accounting/overview");
    }
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.inventoryAdjust]) });
    await expect(specialistCreateEntry()).resolves.toEqual({ industry, draftScope: "business:member:branch", locationId: "branch", locationName: "شعبهٔ مرکزی" });
    vi.mocked(resolveActiveLocation).mockResolvedValue(null);
    await expect(specialistCreateEntry()).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: false, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.inventoryAdjust]) });
    await expect(specialistCreateEntry()).rejects.toThrow("redirect:/accounting/overview");
  });
  it("gates automotive price and reports pages by their native permissions", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("automotive");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.vehiclesView]) });
    await expect(automotiveProductSectionForPage("prices")).resolves.toEqual({ canEdit: false, canSeeCost: false });
    await expect(automotiveProductSectionForPage("reports")).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.vehiclesView, PERMISSIONS.vehiclesPriceEdit, PERMISSIONS.reportsView]) });
    await expect(automotiveProductSectionForPage("prices")).resolves.toEqual({ canEdit: true, canSeeCost: false });
    await expect(automotiveProductSectionForPage("reports")).resolves.toEqual({ canEdit: true, canSeeCost: false });
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: false, permissions: new Set([PERMISSIONS.vehiclesView, PERMISSIONS.reportsView]) });
    await expect(automotiveProductSectionForPage("prices")).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(getBusinessIndustry).mockResolvedValue("watch");
    await expect(automotiveProductSectionForPage("prices")).resolves.toBeNull();
  });
  it("checks the vehicle permission rather than inventory permission", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("automotive");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "owner", isActive: true, permissions: new Set([PERMISSIONS.inventoryView]) });
    await expect(specialistCatalogueForPage()).rejects.toThrow("redirect:/accounting/overview");
  });
  it("rejects inactive members and unauthenticated users", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("watch");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "owner", isActive: false, permissions: new Set([PERMISSIONS.inventoryView]) });
    await expect(specialistCatalogueForPage()).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(getSession).mockResolvedValue(null);
    await expect(specialistCatalogueForPage()).rejects.toThrow("redirect:/login");
  });
  it("leaves other industries for the existing page guard", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("food_service");
    await expect(specialistCatalogueForPage()).resolves.toBeNull();
    vi.mocked(getBusinessIndustry).mockResolvedValue("accessories");
    await expect(specialistCatalogueForPage()).resolves.toBeNull();
  });
});


describe("variant workspace permission flags", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSession).mockResolvedValue({ businessId: "business", locationId: "branch" } as never);
    vi.mocked(getBusinessIndustry).mockResolvedValue("accessories");
  });

  it("does not infer edit access from inventory.view or integration access", async () => {
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.integrationsManage]) });
    const context = await requireProductWorkspace();
    expect(context).toMatchObject({ canEdit: false, canEditMeta: false, canManageStore: false });
    await expect(requireProductWorkspace({ edit: true })).rejects.toThrow("redirect:/accounting/overview");
  });

  it("requires each native permission in addition to inventory.adjust", async () => {
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.inventoryAdjust]) });
    expect(await requireProductWorkspace()).toMatchObject({ canEdit: true, canEditMeta: false, canManageStore: false });
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.inventoryAdjust, PERMISSIONS.menuEdit, PERMISSIONS.integrationsManage]) });
    expect(await requireProductWorkspace()).toMatchObject({ canEdit: true, canEditMeta: true, canManageStore: true });
  });
});


describe("retail label gallery gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSession).mockResolvedValue({ businessId: "business" } as never);
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.vehiclesView]) });
  });
  it.each(["jewelry", "watch", "accessories", "cosmetics", "wholesale", "tools_fittings", "haberdashery", "automotive"] as const)("admits %s with its native read permission", async (industry) => {
    vi.mocked(getBusinessIndustry).mockResolvedValue(industry);
    expect(await requireRetailLabels()).toEqual({ industry, canManage: false, canPrint: false, canAssignBarcode: false, locationId: null, canViewLegacyWeight: false, canEditLegacyWeight: false });
  });
  it.each(["food_service", "service_saas", "architecture_construction", "advertising_agency"] as const)("excludes %s", async (industry) => {
    vi.mocked(getBusinessIndustry).mockResolvedValue(industry);
    await expect(requireRetailLabels()).rejects.toThrow("redirect:/accounting/overview");
  });
  it("requires vehicles.view for automotive and separately resolves settings and printing permissions", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("automotive");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.settingsManage, PERMISSIONS.printingExecute]) });
    await expect(requireRetailLabels()).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.vehiclesView, PERMISSIONS.settingsManage]) });
    expect(await requireRetailLabels()).toEqual({ industry: "automotive", canManage: true, canPrint: false, canAssignBarcode: false, locationId: null, canViewLegacyWeight: false, canEditLegacyWeight: false });
  });
  it("resolves printing permission independently of catalogue read and settings", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("watch");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.printingExecute]) });
    expect(await requireRetailLabels()).toMatchObject({ canPrint: true, canManage: false });
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.settingsManage]) });
    expect(await requireRetailLabels()).toMatchObject({ canPrint: false, canManage: true });
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.printingExecute]) });
    await expect(requireRetailLabels()).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.inventoryAdjust]) });
    vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "branch" } as never);
    expect(await requireRetailLabels()).toMatchObject({ canPrint: false, canAssignBarcode: true, locationId: "branch" });
  });
  it("exposes legacy patterns only to variant users with the weight API read permissions", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("cosmetics");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.menuView, PERMISSIONS.inventoryAdjust]) });
    expect(await requireRetailLabels()).toMatchObject({ canViewLegacyWeight: true, canEditLegacyWeight: false });
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: true, permissions: new Set([PERMISSIONS.inventoryView, PERMISSIONS.menuView, PERMISSIONS.inventoryAdjust, PERMISSIONS.menuEdit]) });
    expect(await requireRetailLabels()).toMatchObject({ canViewLegacyWeight: true, canEditLegacyWeight: true });
    vi.mocked(getBusinessIndustry).mockResolvedValue("jewelry");
    expect(await requireRetailLabels()).toMatchObject({ canViewLegacyWeight: false, canEditLegacyWeight: false });
  });
  it("rejects suspended and unauthenticated members", async () => {
    vi.mocked(getBusinessIndustry).mockResolvedValue("watch");
    vi.mocked(memberAccessFor).mockResolvedValue({ role: "manager", isActive: false, permissions: new Set([PERMISSIONS.inventoryView]) });
    await expect(requireRetailLabels()).rejects.toThrow("redirect:/accounting/overview");
    vi.mocked(getSession).mockResolvedValue(null);
    await expect(requireRetailLabels()).rejects.toThrow("redirect:/login");
  });
});
