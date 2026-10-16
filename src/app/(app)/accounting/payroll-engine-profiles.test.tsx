// @vitest-environment jsdom

/**
 * The payroll cost-allocation profile editor (issue #868) — the editor used to
 * rebuild each share from just percent/location/project/label, silently
 * stripping a dimension tuple that had been saved through the API. This
 * contract: a share's tuple RESTORES into the editor and SURVIVES a save.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import type { PayrollProfile } from "@/lib/payroll-engine-setup";
import { PayrollEngineProfiles } from "./payroll-engine-profiles";

afterEach(cleanup);

const CC = "55555555-5555-4555-8555-555555555555";
const LOC = "11111111-1111-4111-8111-111111111111";

function profile(overrides: Partial<PayrollProfile> = {}): PayrollProfile {
  return {
    userId: "user-1",
    fullName: "کاربر یک",
    employeeCode: "E-1",
    payrollCode: "P-1",
    employmentType: "full_time",
    hireDate: "2025-01-01",
    terminationDate: null,
    baseSalary: "30000000",
    insuranceProfile: { insured: true, insuranceNumber: "INS-1" },
    taxProfile: { exempt: false, nationalId: null },
    paymentDestination: { method: "cash", paymentAccountId: null, iban: null, cardNumber: null },
    costAllocation: [
      {
        percent: 100,
        locationId: LOC,
        projectId: null,
        label: "سهم اصلی",
        costCenterId: CC,
        profitCenterId: null,
        departmentId: null,
        detailDimensionId: null,
      },
    ],
    isActive: true,
    configured: true,
    ...overrides,
  };
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let requests: Recorded[];

beforeEach(() => {
  requests = [];
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
    if (method === "GET" && path === "/api/ledger/payroll/engine/profiles") {
      return respond({ profiles: [profile()] });
    }
    if (method === "GET" && path === "/api/locations/active") {
      return respond({ locations: [{ id: LOC, name: "شعبهٔ مرکزی" }] });
    }
    if (method === "GET" && path === "/api/ai/projects") {
      return respond({ projects: [] });
    }
    if (method === "GET" && path === "/api/ledger/payroll/preview") {
      return respond({ paymentAccounts: [] });
    }
    return respond({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

/** The catalog the mocked hook reports: cost centre on. */
vi.mock("./dimension-fields", () => ({
  useDimensionCatalog: () => ({
    catalog: {
      settings: [
        { kind: "cost_center", isEnabled: true, label: null, defaultLabel: "مرکز هزینه", description: "" },
        { kind: "profit_center", isEnabled: false, label: null, defaultLabel: "مرکز سود", description: "" },
        { kind: "department", isEnabled: false, label: null, defaultLabel: "واحد سازمانی", description: "" },
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
    <button
      type="button"
      // Re-emits the current value unchanged: the point is that the value
      // EXISTS on the draft (restored from the profile) and round-trips.
      onClick={() => onChange({ ...value, cost_center: value.cost_center || "" })}
    >
      زمین ابعاد سهم
    </button>
  ),
}));

function renderProfiles() {
  return render(
    <MoneyProvider unit="rial">
      <PayrollEngineProfiles canManage />
    </MoneyProvider>,
  );
}

function putCall(): { costAllocation?: Record<string, unknown>[] } | null {
  const call = requests.find(
    (r) => r.method === "PUT" && r.url.includes("/api/ledger/payroll/engine/profiles/"),
  );
  return (call?.body as { costAllocation?: Record<string, unknown>[] }) ?? null;
}

describe("PayrollEngineProfiles — a share's dimension tuple survives the editor (issue #868)", () => {
  it("restores the tuple into the share draft and sends it back on save", async () => {
    renderProfiles();
    fireEvent.click(await screen.findByRole("button", { name: "ویرایش پرونده" }));
    // The share's tuple is on the draft (the mock picker re-emits it unchanged).
    const picker = await screen.findByRole("button", { name: "زمین ابعاد سهم" });
    expect(picker).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ذخیره پرونده" }));
    await waitFor(() => expect(putCall()).not.toBeNull());
    const body = putCall();
    // The whole share round-trips — the editor must not strip the tuple.
    expect(body?.costAllocation).toHaveLength(1);
    expect(body?.costAllocation?.[0]).toMatchObject({
      percent: 100,
      locationId: LOC,
      label: "سهم اصلی",
      costCenterId: CC,
      profitCenterId: null,
      departmentId: null,
      detailDimensionId: null,
    });
  });
});
