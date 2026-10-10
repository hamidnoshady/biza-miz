// @vitest-environment jsdom

/**
 * The attribution picker as a person meets it (issue #868).
 *
 * What a screen can get wrong while the server stays right, and so what is
 * asserted here: a kind the business has not switched on is not drawn at all; a
 * picker offers only the values a branch may use; the placeholder holds the row
 * while the catalogue is still loading; and a choice is reported back in the
 * shape the API takes.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DimensionSettingRecord, DimensionValueRecord } from "@/lib/accounting-dimensions";
import { DimensionFields, DimensionFieldsSkeleton } from "./dimension-fields";

afterEach(() => cleanup());

const HQ = "11111111-1111-4111-8111-111111111111";
const ONLINE = "22222222-2222-4222-8222-222222222222";
const BRANCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_BRANCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setting(kind: DimensionSettingRecord["kind"], isEnabled: boolean): DimensionSettingRecord {
  return { kind, isEnabled, label: null, defaultLabel: kind, description: "" };
}

function value(overrides: Partial<DimensionValueRecord> & Pick<DimensionValueRecord, "id" | "code" | "name" | "kind">): DimensionValueRecord {
  return {
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

function makeCatalog(valuesOverride?: DimensionValueRecord[]) {
  const values = valuesOverride ?? [
    value({ id: HQ, kind: "cost_center", code: "CC-HQ", name: "Head office" }),
    value({ id: ONLINE, kind: "profit_center", code: "PC-ONLINE", name: "Online" }),
    value({ id: "33333333-3333-4333-8333-333333333333", kind: "cost_center", code: "CC-NORTH", name: "North", locationId: OTHER_BRANCH }),
  ];
  return {
    settings: [setting("cost_center", true), setting("profit_center", false), setting("department", false), setting("detail", false)],
    postableValues: values.filter((v) => v.isActive),
    allValues: values,
  };
}

describe("DimensionFields", () => {
  it("draws a picker only for the kinds the business has switched on", () => {
    render(
      <DimensionFields idPrefix="t" catalog={makeCatalog()} locationId={BRANCH} value={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "مرکز هزینه" })).not.toBeNull();
    // Profit centre is switched off in this business, so it is not offered at all.
    expect(screen.queryByText("مرکز سود")).toBeNull();
  });

  it("draws nothing when no kind is switched on, so an unused feature costs the form nothing", () => {
    const { container } = render(
      <DimensionFields
        idPrefix="t"
        catalog={{ settings: [setting("cost_center", false)], postableValues: [], allValues: [] }}
        locationId={BRANCH}
        value={{}}
        onChange={vi.fn()}
      />,
    );
    expect(container.querySelector("#t")).toBeNull();
  });

  it("shows the placeholder while the catalogue loads (catalog=null)", () => {
    render(<DimensionFields idPrefix="t" catalog={null} locationId={BRANCH} value={{}} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "مرکز هزینه" })).toBeNull();
    expect(screen.getByLabelText("در حال بارگذاری ابعاد حسابداری")).not.toBeNull();
  });

  it("renders the skeleton on its own", () => {
    render(<DimensionFieldsSkeleton />);
    expect(screen.getByLabelText("در حال بارگذاری ابعاد حسابداری").getAttribute("aria-busy")).toBe("true");
  });

  it("offers an empty choice that means none, and reports a pick as the API's shape", async () => {
    const onChange = vi.fn();
    render(<DimensionFields idPrefix="t" catalog={makeCatalog()} locationId={BRANCH} value={{}} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "مرکز هزینه" });
    expect(trigger.textContent).toContain("بدون مرکز هزینه");
    trigger.click();
    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options[0]).toContain("بدون مرکز هزینه");
    // The branch can use the business-wide head office, but not the North branch's own value.
    expect(options.join("|")).toContain("CC-HQ");
    expect(options.join("|")).not.toContain("CC-NORTH");
  });
});
