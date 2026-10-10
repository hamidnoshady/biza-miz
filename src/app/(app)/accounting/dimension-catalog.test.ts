import { describe, expect, it } from "vitest";
import type { DimensionSettingRecord, DimensionValueRecord } from "@/lib/accounting-dimensions";
import {
  dimensionFilterOptionsFor,
  dimensionOptionsFor,
  dimensionPayload,
  enabledDimensionKinds,
  enabledKindLabel,
  hasDimensionDraft,
  loadDimensionCatalog,
} from "./dimension-catalog";

const HQ = "11111111-1111-4111-8111-111111111111";
const SALES = "22222222-2222-4222-8222-222222222222";
const NORTH_ONLY = "33333333-3333-4333-8333-333333333333";
const GROUP = "44444444-4444-4444-8444-444444444444";
const BRANCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_BRANCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setting(kind: DimensionSettingRecord["kind"], isEnabled: boolean, label: string | null = null): DimensionSettingRecord {
  return {
    kind,
    isEnabled,
    label,
    defaultLabel: kind === "detail" ? "بعد تحلیلی" : kind,
    description: "",
  };
}

function value(overrides: Partial<DimensionValueRecord> & Pick<DimensionValueRecord, "id" | "code" | "name">): DimensionValueRecord {
  return {
    kind: "cost_center",
    parentId: null,
    parentCode: null,
    parentName: null,
    locationId: null,
    locationName: null,
    effectiveFrom: null,
    effectiveTo: null,
    isActive: true,
    hasChildren: false,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
    ...overrides,
  };
}

describe("enabledDimensionKinds", () => {
  it("returns only the switched-on kinds, in product order", () => {
    const settings = [setting("detail", true), setting("cost_center", false), setting("profit_center", true), setting("department", false)];
    expect(enabledDimensionKinds(settings)).toEqual(["profit_center", "detail"]);
  });

  it("is empty for a business that has never opened the feature, or whose settings did not load", () => {
    expect(enabledDimensionKinds([])).toEqual([]);
    expect(enabledDimensionKinds(undefined)).toEqual([]);
  });
});

describe("enabledKindLabel", () => {
  it("uses the business's own name for the detail kind, and the product name for the rest", () => {
    const settings = [setting("detail", true, "پروژه‌های داخلی"), setting("cost_center", true)];
    expect(enabledKindLabel(settings, "detail")).toBe("پروژه‌های داخلی");
    expect(enabledKindLabel(settings, "cost_center")).toBe("مرکز هزینه");
    expect(enabledKindLabel([], "detail")).toBe("بعد تحلیلی");
  });
});

describe("dimensionOptionsFor", () => {
  const values = [
    value({ id: SALES, code: "CC-SALES", name: "Sales" }),
    value({ id: HQ, code: "CC-HQ", name: "Head office" }),
    value({ id: NORTH_ONLY, code: "CC-NORTH", name: "North", locationId: OTHER_BRANCH }),
    value({ id: GROUP, code: "CC-GROUP", name: "Group", hasChildren: true }),
    value({ id: "55555555-5555-4555-8555-555555555555", code: "PC-ONLINE", name: "Online", kind: "profit_center" }),
  ];

  it("offers only leaf, active values of the kind, sorted by code", () => {
    const options = dimensionOptionsFor(values, "cost_center", BRANCH);
    expect(options.map((o) => o.value)).toEqual([HQ, SALES]);
    expect(options[0].label).toBe("CC-HQ · Head office");
  });

  it("leaves out a value restricted to another branch, and keeps a business-wide one", () => {
    // Sorted by code: CC-HQ, CC-NORTH, CC-SALES.
    expect(dimensionOptionsFor(values, "cost_center", OTHER_BRANCH).map((o) => o.value)).toEqual([HQ, NORTH_ONLY, SALES]);
    expect(dimensionOptionsFor(values, "cost_center", null).map((o) => o.value)).not.toContain(NORTH_ONLY);
  });

  it("never offers an archived value, even if one reaches the list", () => {
    const withArchived = [...values, value({ id: BRANCH, code: "CC-OLD", name: "Old", isActive: false })];
    expect(dimensionOptionsFor(withArchived, "cost_center", BRANCH).map((o) => o.value)).not.toContain(BRANCH);
  });

  it("returns nothing for a kind with no values", () => {
    expect(dimensionOptionsFor(values, "department", BRANCH)).toEqual([]);
    expect(dimensionOptionsFor(undefined, "cost_center", BRANCH)).toEqual([]);
  });
});

describe("dimensionPayload", () => {
  it("carries only the kinds that name a value, and nothing when none do", () => {
    expect(dimensionPayload({ cost_center: HQ, profit_center: "" })).toEqual({ cost_center: HQ });
    expect(dimensionPayload({ cost_center: "" })).toBeUndefined();
    expect(dimensionPayload(undefined)).toBeUndefined();
    expect(dimensionPayload({})).toBeUndefined();
  });

  it("reports whether a draft names anything", () => {
    expect(hasDimensionDraft({ department: SALES })).toBe(true);
    expect(hasDimensionDraft({ department: "" })).toBe(false);
  });
});

describe("loadDimensionCatalog", () => {
  it("splits postable (active-only) and historical (all) values", async () => {
    const result = await loadDimensionCatalog(async () => ({
      ok: true,
      data: {
        settings: [setting("cost_center", true)],
        values: [value({ id: HQ, code: "CC-HQ", name: "HQ" }), value({ id: SALES, code: "CC-OLD", name: "Old", isActive: false })],
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog.postableValues.map((v) => v.id)).toEqual([HQ]);
      expect(result.catalog.allValues.map((v) => v.id).sort()).toEqual([HQ, SALES].sort());
      expect(result.catalog.settings).toHaveLength(1);
    }
  });

  it("returns ok=false on failure so the caller can surface an error, not silently empty", async () => {
    const fail1 = await loadDimensionCatalog(async () => ({ ok: false, data: { error: "x" }, status: 500 }));
    expect(fail1.ok).toBe(false);
    const fail2 = await loadDimensionCatalog(async () => ({ ok: true, data: null }));
    expect(fail2.ok).toBe(false);
  });
});

describe("dimensionFilterOptionsFor", () => {
  it("offers every leaf value across branches, archived included, so historical filters keep working", () => {
    const values = [
      value({ id: HQ, code: "CC-HQ", name: "HQ" }),
      value({ id: NORTH_ONLY, code: "CC-NORTH", name: "North", locationId: OTHER_BRANCH }),
      value({ id: GROUP, code: "CC-GROUP", name: "Group", hasChildren: true }),
      value({ id: SALES, code: "CC-OLD", name: "Old", isActive: false }),
    ];
    expect(dimensionFilterOptionsFor(values, "cost_center").map((o) => o.value)).toEqual([HQ, NORTH_ONLY, SALES]);
  });
});
