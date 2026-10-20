// @vitest-environment jsdom

/** UI contracts for the retail supplier-return voucher (issue #918). */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/app/dashboard/ui";
import { ReturnsSection } from "./returns-section";

vi.mock("@/app/dashboard/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/dashboard/ui")>();
  return { ...actual, api: vi.fn() };
});

// Use a native select at this boundary: the component under test owns the
// option lists, controlled values, validation and submission contract; the
// shared SearchableSelect keyboard/filter behavior is covered by its own suite.
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));

const ITEM_STANDARD = {
  id: "item-standard",
  name: "کالای معمولی",
  sku: "STD-1",
  tracking: "none",
  quantity: "12",
  unitCost: 500,
  unitPrice: 900,
};
const ITEM_BATCH = {
  id: "item-batch",
  name: "کالای بچ‌دار",
  sku: "BAT-1",
  tracking: "batch",
  quantity: "4",
  unitCost: 100,
  unitPrice: 200,
};
const ITEM_SERIAL = {
  id: "item-serial",
  name: "کالای سریالی",
  sku: "SER-1",
  tracking: "serial",
  quantity: "2",
  unitCost: 200,
  unitPrice: 300,
};
const ITEM_WEIGHT = {
  id: "item-weight",
  name: "طلای وزنی",
  sku: "W-1",
  tracking: "weight",
  quantity: "10",
  unitCost: 1_000,
  unitPrice: 2_000,
};
const ITEMS = [ITEM_STANDARD, ITEM_BATCH, ITEM_SERIAL, ITEM_WEIGHT];

const PURCHASE = {
  id: "purchase-1",
  supplier_id: "supplier-1",
  supplier_name: "تأمین‌کننده نمونه",
  status: "received",
  location_id: "location-1",
  location_name: "شعبه مرکزی",
  note: null,
  total: "500",
  received_at: "2026-10-19T08:00:00.000Z",
};
const PURCHASE_DETAIL = {
  purchase: PURCHASE,
  lines: [
    {
      purchase_item_id: "purchase-item-batch",
      item_id: ITEM_BATCH.id,
      item_name: ITEM_BATCH.name,
      sku: ITEM_BATCH.sku,
      tracking: "batch",
      quantity_received: "3",
      unit_cost: "100",
      batch_number: "LOT-42",
      expiry_date: null,
      quantity_returned: "0",
    },
    {
      purchase_item_id: "purchase-item-serial",
      item_id: ITEM_SERIAL.id,
      item_name: ITEM_SERIAL.name,
      sku: ITEM_SERIAL.sku,
      tracking: "serial",
      quantity_received: "1",
      unit_cost: "200",
      batch_number: null,
      expiry_date: null,
      quantity_returned: "0",
    },
  ],
  availableSerials: [
    { item_id: ITEM_SERIAL.id, serial_id: "serial-1", serial_number: "SN-RET-1", unit_cost: "200" },
  ],
};
const RETURN_ROW = {
  id: "allowed-return", return_number: "1", purchase_id: null, supplier_id: "supplier-1",
  supplier_name: "تأمین‌کننده نمونه", location_id: "location-1", location_name: "شعبه مرکزی",
  settlement_method: "cash", total_value_rial: "100", supplier_credit_rial: "100", variance_rial: "0",
  reason: "آسیب‌دیده", status: "posted", created_at: "2026-10-19T08:00:00.000Z", created_by_name: null, line_count: 1,
};
const RETURN_DETAIL = {
  document: { ...RETURN_ROW, purchase_note: null, purchase_received_at: null, reversal_entry_id: null, reversal_reason: null, reversed_at: null, reversed_by: null },
  lines: [], journal: null, reversalJournal: null, corrections: [],
};

const BATCHES = [
  {
    id: "batch-1",
    batchNumber: "LOT-42",
    expiryDate: null,
    manufactureDate: null,
    quantity: "4",
    unitCost: 100,
    supplierReference: null,
    purchaseId: PURCHASE.id,
    purchaseReceivedAt: PURCHASE.received_at,
    supplierName: "تأمین‌کننده نمونه",
  },
];

let canWrite: boolean;
let itemFetchFailures: number;
let registerRows: Record<string, unknown>[];
let returnDetailFails: boolean;
const request = vi.mocked(api);

function answer<T>(data: T, ok = true) {
  return { ok, status: ok ? 200 : 503, data, aborted: false };
}

function mockApi() {
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/stock/items") {
      if (itemFetchFailures > 0) {
        itemFetchFailures -= 1;
        return answer({ error: "network_error" }, false) as never;
      }
      return answer({ items: ITEMS }) as never;
    }
    if (url === "/api/stock/purchases") {
      return answer({
        purchases: [{
          id: PURCHASE.id,
          total: 500,
          note: null,
          receivedAt: PURCHASE.received_at,
          supplierId: PURCHASE.supplier_id,
          supplierName: PURCHASE.supplier_name,
          status: PURCHASE.status,
          lineCount: 2,
        }],
        suppliers: [{ id: "supplier-1", name: "تأمین‌کننده نمونه" }],
      }) as never;
    }
    if (url === `/api/stock/purchases/${PURCHASE.id}`) return answer(PURCHASE_DETAIL) as never;
    if (url.startsWith("/api/stock/batches?item=")) return answer({ batches: BATCHES }) as never;
    if (url === "/api/stock/returns?pageSize=1") return answer({ canWrite }) as never;
    if (/^\/api\/stock\/returns\/[^?]+$/.test(url)) {
      if (init?.method === "POST") return answer({ ok: true }) as never;
      return returnDetailFails ? answer({ error: "return_not_found" }, false) as never : answer(RETURN_DETAIL) as never;
    }
    if (url.startsWith("/api/stock/returns?page=")) return answer({ returns: registerRows, total: registerRows.length, canWrite }) as never;
    return answer({ error: "unexpected_test_request" }, false) as never;
  });
}

beforeEach(() => {
  canWrite = true;
  itemFetchFailures = 0;
  registerRows = [];
  returnDetailFails = false;
  vi.clearAllMocks();
  mockApi();
});

afterEach(() => {
  cleanup();
});

describe("retail supplier-return voucher editor", () => {
  it("renders the editor and offers purchase-scoped batch and serial pickers", async () => {
    const user = userEvent.setup();
    render(<ReturnsSection />);

    expect(await screen.findByText("حواله بازگشت جدید")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ثبت قطعی حواله بازگشت" })).toBeTruthy();
    expect(screen.getByText(/مالیات و تخفیف خرید در دادهٔ مبنا ذخیره نشده/)).toBeTruthy();
    expect(screen.getByText(/کالای وزنی در فهرست کالا پنهان است/)).toBeTruthy();

    const purchaseSelect = screen.getByRole("combobox", { name: "انتخاب خرید مبنا برای برگشت" });
    await user.selectOptions(purchaseSelect, PURCHASE.id);
    await screen.findByText("شعبه مرکزی");

    const firstItem = screen.getByRole("combobox", { name: "کالای ردیف 1" });
    await user.selectOptions(firstItem, ITEM_BATCH.id);
    await waitFor(() =>
      expect(request.mock.calls.some(([url]) => url === `/api/stock/batches?item=${ITEM_BATCH.id}`)).toBe(true),
    );
    const batchPicker = await screen.findByRole("combobox", { name: "بچ ردیف 1" });
    await waitFor(() => expect(within(batchPicker).getByRole("option", { name: /LOT-42/ })).toBeTruthy());
    await user.selectOptions(batchPicker, "batch-1");

    await user.click(screen.getByRole("button", { name: "افزودن ردیف" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "کالای ردیف 2" }), ITEM_SERIAL.id);
    const serialPicker = await screen.findByRole("combobox", { name: "دستگاه ردیف 2" });
    await waitFor(() => expect(within(serialPicker).getByRole("option", { name: /SN-RET-1/ })).toBeTruthy());
    await user.selectOptions(serialPicker, "serial-1");

    const serialQuantity = screen.getByRole("textbox", { name: "تعداد ردیف 2" }) as HTMLInputElement;
    expect(serialQuantity.value).toBe("۱");
    expect(serialQuantity.disabled).toBe(true);
    expect(request.mock.calls.some(([url]) => url === `/api/stock/purchases/${PURCHASE.id}`)).toBe(true);
  });

  it("shows the register but withholds the editor when inventory.adjust is absent", async () => {
    canWrite = false;
    render(<ReturnsSection />);

    expect(await screen.findByText(/ثبت حواله بازگشت نیازمند دسترسی «اصلاح انبار» است/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ثبت قطعی حواله بازگشت" })).toBeNull();
    expect(screen.getByRole("region", { name: "دفتر حواله‌های بازگشت" })).toBeTruthy();
  });

  it("offers the audited reversal only to a writer and requires a reason plus explicit confirmation", async () => {
    registerRows = [RETURN_ROW];
    const user = userEvent.setup();
    render(<ReturnsSection />);

    await user.click(await screen.findByRole("button", { name: /جزئیات حواله/ }));
    await screen.findByText(/حوالهٔ ۱/);
    const reverseButton = screen.getByRole("button", { name: "معکوس‌سازی حسابرسی‌شده" }) as HTMLButtonElement;
    expect(reverseButton.disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "دلیل معکوس‌سازی حواله" }), "اشتباه در حواله");
    await user.click(screen.getByRole("checkbox"));
    expect(reverseButton.disabled).toBe(false);
  });

  it("keeps a branch-scoped read-only register and handles a foreign/now-inaccessible detail as not found", async () => {
    canWrite = false;
    returnDetailFails = true;
    registerRows = [{
      id: "allowed-return", return_number: "۱", purchase_id: null, supplier_id: "supplier-allowed",
      supplier_name: "تأمین‌کنندهٔ مجاز", location_id: "location-allowed", location_name: "شعبه مجاز",
      settlement_method: "cash", total_value_rial: "100", supplier_credit_rial: "100", variance_rial: "0",
      reason: "آسیب‌دیده", status: "posted", created_at: "2026-10-19T08:00:00.000Z", created_by_name: null, line_count: 1,
    }];
    const user = userEvent.setup();
    render(<ReturnsSection />);

    expect(await screen.findByText("تأمین‌کنندهٔ مجاز")).toBeTruthy();
    expect(screen.queryByText("تأمین‌کنندهٔ شعبهٔ دیگر")).toBeNull();
    expect(screen.queryByRole("button", { name: "ثبت قطعی حواله بازگشت" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /جزئیات حواله/ }));
    expect(await screen.findByText(/دریافت جزئیات حواله ناموفق بود/)).toBeTruthy();
    expect(request.mock.calls.some(([url]) => url === "/api/stock/returns/allowed-return")).toBe(true);
  });

  it("recovers from a failed item fetch through the visible retry", async () => {
    itemFetchFailures = 1;
    const user = userEvent.setup();
    render(<ReturnsSection />);

    expect(await screen.findByText(/دریافت اطلاعات لازم برای فرم/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));

    expect(await screen.findByRole("button", { name: "ثبت قطعی حواله بازگشت" })).toBeTruthy();
    expect(request.mock.calls.filter(([url]) => url === "/api/stock/items")).toHaveLength(2);
  });

  it("discloses the default bank clearing account and missing bank-reference support", async () => {
    const user = userEvent.setup();
    render(<ReturnsSection />);
    await screen.findByRole("button", { name: "ثبت قطعی حواله بازگشت" });

    await user.selectOptions(screen.getByRole("combobox", { name: "انتخاب روش تسویه برگشت" }), "bank");
    expect(screen.getByText(/حساب واسط بانکی پیش‌فرض ۱۱۲۰/)).toBeTruthy();
    expect(screen.getByText(/انتخاب حساب بانکی\/خزانه یا شمارهٔ پیگیری پشتیبانی نمی‌شود/)).toBeTruthy();
  });
});
