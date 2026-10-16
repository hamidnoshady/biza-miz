// @vitest-environment jsdom

/**
 * The trading attribution rules tab (issue #868) — the management surface for
 * `accounting_dimension_mappings`, which PR #898 shipped service-only. Proven
 * here: the tab lists rules with readable tuples (archived values labelled),
 * a created rule carries the whole tuple to the API, and deleting a rule is a
 * rule-level delete — the copy says posted history is untouched and the call
 * is exactly DELETE on the rule.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionMappingsTab, type MappingRecord } from "./dimension-mappings-tab";
import type { DimensionValueRecord } from "@/lib/accounting-dimensions";

afterEach(cleanup);

const CC = "55555555-5555-4555-8555-555555555555";
const DEPT = "66666666-6666-4666-8666-666666666666";

const VALUES: DimensionValueRecord[] = [
  {
    id: CC,
    kind: "cost_center",
    code: "CC-1",
    name: "دفتر مرکزی",
    parentId: null,
    parentCode: null,
    parentName: null,
    locationId: null,
    locationName: null,
    effectiveFrom: null,
    effectiveTo: null,
    isActive: true,
    hasChildren: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: DEPT,
    kind: "department",
    code: "D-1",
    name: "مالی",
    parentId: null,
    parentCode: null,
    parentName: null,
    locationId: null,
    locationName: null,
    effectiveFrom: null,
    effectiveTo: null,
    // Archived: readable in the tuple, never blanked.
    isActive: false,
    hasChildren: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function rule(overrides: Partial<MappingRecord> = {}): MappingRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scope: "item",
    ref: "SKU-1",
    dimensions: { cost_center: CC, department: DEPT },
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    note: null,
    updatedAt: "2026-10-16T08:00:00.000Z",
    ...overrides,
  };
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let requests: Recorded[];
let rules: MappingRecord[];

beforeEach(() => {
  requests = [];
  rules = [rule()];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    requests.push({ method, url: String(input), body });
    const respond = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
    const path = new URL(String(input), "http://localhost").pathname;
    if (method === "GET" && path === "/api/ledger/dimensions/mappings") return respond({ mappings: rules });
    if (method === "POST" && path === "/api/ledger/dimensions/mappings") {
      rules = [...rules, rule({ ...(body as MappingRecord), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })];
      return respond({ mapping: rules[rules.length - 1] }, 201);
    }
    if (method === "DELETE" && path.startsWith("/api/ledger/dimensions/mappings/")) {
      rules = [];
      return respond({ deleted: true });
    }
    return respond({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

/** The catalog the mocked hook reports: cost centre on, department on (archived value). */
vi.mock("./dimension-fields", () => ({
  useDimensionCatalog: () => ({
    catalog: {
      settings: [
        { kind: "cost_center", isEnabled: true, label: null, defaultLabel: "مرکز هزینه", description: "" },
        { kind: "profit_center", isEnabled: false, label: null, defaultLabel: "مرکز سود", description: "" },
        { kind: "department", isEnabled: true, label: null, defaultLabel: "واحد سازمانی", description: "" },
        { kind: "detail", isEnabled: false, label: null, defaultLabel: "بعد تحلیلی", description: "" },
      ],
      postableValues: [],
      allValues: [],
      truncated: false,
      truncatedAt: null,
    },
    loaded: true,
    error: null,
    retry: () => undefined,
  }),
  DimensionFields: ({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) => (
    <button type="button" onClick={() => onChange({ ...value, cost_center: CC })}>
      انتخاب مرکز هزینه
    </button>
  ),
}));

function renderTab(canManage = true) {
  return render(<DimensionMappingsTab values={VALUES} canManage={canManage} />);
}

describe("DimensionMappingsTab — trading attribution rules (issue #868)", () => {
  it("lists a rule's tuple with archived values labelled, never blank", async () => {
    renderTab();
    await screen.findAllByText("SKU-1");
    expect(screen.getAllByText("CC-۱ · دفتر مرکزی").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/D-۱ · مالی \(بایگانی\)/).length).toBeGreaterThanOrEqual(1);
  });

  it("creates a rule carrying the whole tuple to the API", async () => {
    renderTab();
    await screen.findAllByText("SKU-1");
    fireEvent.click(screen.getByRole("button", { name: /افزودن قاعده/ }));
    fireEvent.change(screen.getByPlaceholderText("SKU / کد کالا"), { target: { value: "SKU-9" } });
    fireEvent.click(screen.getByRole("button", { name: "انتخاب مرکز هزینه" }));
    fireEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === "POST" && r.url.endsWith("/api/ledger/dimensions/mappings"))).toBe(true);
    });
    const post = requests.find((r) => r.method === "POST");
    const body = post?.body as { scope: string; ref: string; dimensions: Record<string, string | null>; isActive: boolean };
    expect(body.scope).toBe("item");
    expect(body.ref).toBe("SKU-9");
    expect(body.dimensions).toEqual({
      cost_center: CC,
      profit_center: null,
      department: null,
      detail: null,
    });
    expect(body.isActive).toBe(true);
  });

  it("deletes a rule at rule level — the call is exactly DELETE on the rule", async () => {
    renderTab();
    await screen.findAllByText("SKU-1");
    fireEvent.click(screen.getByRole("button", { name: /حذف/ }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    });
    const del = requests.find((r) => r.method === "DELETE");
    expect(del?.url).toBe(`/api/ledger/dimensions/mappings/${rule().id}`);
    // And the screen says history is untouched.
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/سوابق ثبت‌شده تغییری نمی‌کنند/);
  });

  it("hides write controls from a read-only viewer", async () => {
    renderTab(false);
    await screen.findAllByText("SKU-1");
    expect(screen.queryByRole("button", { name: /افزودن قاعده/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /ویرایش/ })).toBeNull();
  });
});
