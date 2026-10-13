// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomotiveManager } from "./automotive-manager";

const readOnlyProps = {
  canSeeCost: false,
  canCreateVehicle: false,
  canEditCost: false,
  canOverrideMinPrice: false,
  canEditVehicle: false,
  canEditPrice: false,
  canReserveVehicle: false,
  canCancelReservation: false,
  canSellVehicle: false,
  canRecordCost: false,
  canViewLeads: true,
  canManageLeads: false,
  canCreateCustomer: false,
  canTransferVehicle: false,
  canArchiveVehicle: false,
  canViewMedia: false,
  canManageMedia: false,
  defaultVatPercent: 9,
};

const overview = {
  onDate: "2026-10-10",
  summary: {
    inStock: 0,
    reserved: 0,
    sold: 0,
    averageAgeDays: null,
    slowCount: 0,
    deadCount: 0,
    soldThisMonth: 0,
  },
};

const preferences = {
  make: "پژو",
  model: "207",
  trim: null,
  condition: "used" as const,
  vehicleYearCalendar: "jalali" as const,
  modelYearFrom: 1400,
  modelYearTo: 1403,
  budgetFromRial: 100_000_000,
  budgetToRial: 500_000_000,
  tradeIn: false,
  tradeInDescription: null,
  testDriveRequestedAt: null,
  notes: "اولویت با خودروی کم‌کارکرد",
};

const leadProfile = {
  leadId: "lead-1",
  leadName: "یاسمن رضایی",
  leadStatus: "working",
  phone: null,
  preferences,
  links: [],
};

function installApiStub() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let data: unknown;
    if (url.startsWith("/api/automotive/overview")) {
      data = overview;
    } else if (url.startsWith("/api/automotive/vehicles?")) {
      data = { total: 0, vehicles: [], locations: [{ id: "branch-1", name: "شعبهٔ مرکزی" }], activeLocationId: "branch-1" };
    } else if (url === "/api/crm/leads?limit=50") {
      data = { leads: [{ id: "lead-1", name: "یاسمن رضایی", status: "working", phone: null }] };
    } else if (url === "/api/automotive/leads/lead-1") {
      data = { profile: leadProfile };
    } else {
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    }
    return { ok: true, status: 200, json: async () => data } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("automotive CRM manager permissions", () => {
  it("shows canonical CRM data read-only to a vehicle viewer without crm.manage", async () => {
    const fetchMock = installApiStub();
    const user = userEvent.setup();
    render(<AutomotiveManager {...readOnlyProps} />);

    await user.click(await screen.findByRole("tab", { name: "مشتریان و سرنخ‌ها" }));
    const leadPicker = await screen.findByLabelText("سرنخ");
    await user.selectOptions(leadPicker, "lead-1");

    expect(await screen.findByDisplayValue("پژو")).not.toBeNull();
    expect((screen.getByLabelText("برند") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("مدل") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("از سال مدل") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("تا سال مدل") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("حداکثر بودجه (تومان)") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("خودرو") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "ذخیرهٔ خودروی مورد نظر" })).toBeNull();
    expect(screen.getByText(/دسترسی «مدیریت CRM» برای ویرایش ترجیحات لازم است/)).not.toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/crm/leads?limit=50", expect.anything()));
    expect(fetchMock).toHaveBeenCalledWith("/api/automotive/leads/lead-1", expect.anything());
    const writes = fetchMock.mock.calls.filter(([, init]) =>
      ["POST", "PUT", "PATCH", "DELETE"].includes(init?.method ?? "GET"),
    );
    expect(writes).toHaveLength(0);
  });

  it("does not mount the CRM section or request CRM data without crm.view", async () => {
    const fetchMock = installApiStub();
    render(<AutomotiveManager {...readOnlyProps} canViewLeads={false} />);

    expect(screen.queryByRole("tab", { name: "مشتریان و سرنخ‌ها" })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/crm/leads?limit=50", expect.anything());
  });

  it("sells a car through the business's own payment ways and sends the price as Rial", async () => {
    const car = {
      serialId: "car-1",
      stockNumber: "AUTO-1",
      displayName: "پژو ۲۰۷",
      state: "in_stock",
      condition: "used",
      vin: null,
      chassisNumber: null,
      askingPriceRial: 900_000_000,
      minimumPriceRial: null,
      reservedDepositRial: 0,
      reservedForCustomerId: null,
      reservedForName: null,
      soldPriceRial: null,
      locationId: "branch-1",
    };
    const ways = [
      { id: "pm-cash", code: "cash", name: "نقدی", settlement: "cash", sortOrder: 1, isActive: true, isBuiltin: true, opensDrawer: true, requiresReference: false },
      { id: "pm-mellat", code: "pos-mellat", name: "پوز ملت", settlement: "card", sortOrder: 2, isActive: true, isBuiltin: false, opensDrawer: false, requiresReference: false },
      { id: "pm-cheque", code: "cheque", name: "چک", settlement: "cheque", sortOrder: 3, isActive: true, isBuiltin: true, opensDrawer: false, requiresReference: false },
    ];
    const invoiceBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let data: unknown = {};
      if (url.startsWith("/api/automotive/overview")) data = overview;
      else if (url.startsWith("/api/automotive/vehicles?")) {
        data = { total: 1, vehicles: [car], locations: [{ id: "branch-1", name: "شعبهٔ مرکزی" }], activeLocationId: "branch-1" };
      } else if (url === "/api/payment-methods") data = { paymentMethods: ways };
      else if (url === "/api/sales/invoices" && init?.method === "POST") {
        invoiceBodies.push(JSON.parse(String(init.body)));
        data = { invoice: { orderNumber: "12", total: "981000000" } };
      }
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AutomotiveManager {...readOnlyProps} canViewLeads={false} canSellVehicle />);

    await user.click(await screen.findByRole("tab", { name: "فروش خودرو" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /AUTO-1/ })).not.toBeNull());
    await user.selectOptions(screen.getByLabelText("خودرو"), "car-1");
    // Seeded in the business's unit (Toman by default), never as raw Rial.
    expect((screen.getByLabelText("مبلغ خودرو (تومان)") as HTMLInputElement).value).toBe("۹۰٬۰۰۰٬۰۰۰");

    // The renamed way is offered; a cheque is not an invoice tender.
    await user.click(await screen.findByRole("button", { name: "پوز ملت" }));
    expect(screen.queryByRole("button", { name: "چک" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "صدور فاکتور فروش خودرو" }));

    await waitFor(() => expect(invoiceBodies).toHaveLength(1));
    expect(invoiceBodies[0]).toMatchObject({
      lines: [{ kind: "vehicle", serialId: "car-1", price: 900_000_000, discount: 0, vatPercent: 9 }],
      tenders: [{ method: "bank", paymentMethodId: "pm-mellat" }],
    });
    expect((invoiceBodies[0] as { tenders: { amount?: number }[] }).tenders[0].amount).toBeUndefined();
  });
});
