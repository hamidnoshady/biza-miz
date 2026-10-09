// @vitest-environment jsdom

/**
 * «ابعاد حسابداری» as the browser sees it (issue #868).
 *
 * What a screen can get wrong while the API is right, and so what is asserted:
 * a switch sends exactly the change it shows; a member without `accounts.edit`
 * can read the catalogue and change nothing; a value the server refuses keeps
 * its refusal beside the form, in Persian; and an archived value is offered
 * restoration rather than archival.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionsSection } from "./dimensions-section";

const HQ = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";

const SETTINGS = [
  { kind: "cost_center", isEnabled: true, label: null, defaultLabel: "مرکز هزینه", description: "d" },
  { kind: "profit_center", isEnabled: false, label: null, defaultLabel: "مرکز سود", description: "d" },
  { kind: "department", isEnabled: false, label: null, defaultLabel: "واحد سازمانی", description: "d" },
  { kind: "detail", isEnabled: false, label: null, defaultLabel: "بعد تحلیلی", description: "d" },
];

const VALUES = [
  {
    id: HQ,
    kind: "cost_center",
    code: "CC-HQ",
    name: "Head office",
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
  },
  {
    id: OLD,
    kind: "cost_center",
    code: "CC-OLD",
    name: "Retired centre",
    parentId: null,
    parentCode: null,
    parentName: null,
    locationId: null,
    locationName: null,
    effectiveFrom: null,
    effectiveTo: null,
    isActive: false,
    hasChildren: false,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
  },
];

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function stubFetch(overrides: Record<string, (init?: RequestInit) => unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(overrides).find((k) => String(url).startsWith(k));
    if (key) return overrides[key](init) as ReturnType<typeof json>;
    if (String(url).startsWith("/api/ledger/dimensions?")) return json({ settings: SETTINGS, values: VALUES });
    if (String(url).startsWith("/api/locations/active")) return json({ locations: [{ id: "loc-1", name: "Center" }] });
    return json({});
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the kinds a business uses", () => {
  it("sends exactly the switch the person changed", async () => {
    const { calls } = stubFetch();
    render(<DimensionsSection canManage />);
    const profit = await screen.findByRole("switch", { name: "فعال بودن مرکز سود" });
    fireEvent.click(profit);
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === "PUT");
      expect(put).toBeDefined();
      expect(JSON.parse(String(put!.init!.body))).toEqual({ changes: [{ kind: "profit_center", isEnabled: true }] });
    });
  });

  it("lets a member without accounts.edit read the catalogue and change nothing", async () => {
    stubFetch();
    render(<DimensionsSection canManage={false} />);
    const cost = await screen.findByRole("switch", { name: "فعال بودن مرکز هزینه" });
    expect(cost.getAttribute("data-disabled") !== null || (cost as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "افزودن مقدار" })).toBeNull();
    expect(screen.getByText("CC-HQ")).not.toBeNull();
  });
});

describe("values", () => {
  it("offers restoration for an archived value and archival for an active one", async () => {
    stubFetch();
    render(<DimensionsSection canManage />);
    await screen.findByText("CC-HQ");
    await userEvent.setup().click(screen.getByRole("switch", { name: "نمایش بایگانی‌شده‌ها" }));
    const oldRow = (await screen.findByText("CC-OLD")).closest("tr") as HTMLElement;
    expect(within(oldRow).getByRole("button", { name: "بازگردانی" })).not.toBeNull();
    const hqRow = screen.getByText("CC-HQ").closest("tr") as HTMLElement;
    expect(within(hqRow).getByRole("button", { name: "بایگانی" })).not.toBeNull();
  });

  it("keeps the server's refusal beside the form, in Persian, and leaves the form open", async () => {
    stubFetch({
      "/api/ledger/dimensions": (init) =>
        init?.method === "POST" ? json({ error: "dimension_code_exists" }, 409) : json({ settings: SETTINGS, values: VALUES }),
    });
    render(<DimensionsSection canManage />);
    await screen.findByText("CC-HQ");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "افزودن مقدار" }));
    const form = await screen.findByRole("form", { name: "مقدار تازه" });
    await user.type(within(form).getByRole("textbox", { name: "کد" }), "CC-HQ");
    await user.type(within(form).getByRole("textbox", { name: "نام" }), "Duplicate");
    await user.click(within(form).getByRole("button", { name: "ثبت مقدار" }));
    expect(await within(form).findByText("کد دیگری با همین مقدار در این نوع بُعد وجود دارد.")).not.toBeNull();
    expect(screen.getByRole("form", { name: "مقدار تازه" })).not.toBeNull();
  });

  it("refuses a code with a comma before anything is sent", async () => {
    const { calls } = stubFetch();
    render(<DimensionsSection canManage />);
    await screen.findByText("CC-HQ");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "افزودن مقدار" }));
    const form = await screen.findByRole("form", { name: "مقدار تازه" });
    await user.type(within(form).getByRole("textbox", { name: "کد" }), "A,B");
    await user.type(within(form).getByRole("textbox", { name: "نام" }), "Bad");
    await user.click(within(form).getByRole("button", { name: "ثبت مقدار" }));
    expect(await within(form).findByText("کد نباید ویرگول، گیومه یا خط جدید داشته باشد.")).not.toBeNull();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });
});
