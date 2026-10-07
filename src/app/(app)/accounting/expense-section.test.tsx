// @vitest-environment jsdom

/**
 * The Expenses screen, as the browser sees it (issue #832 §2, §3, §7, §13, §20).
 *
 * Five things are asserted here because they are the ones a screen can get wrong
 * while the API stays right — and the whole point of the audit was that the
 * screen and the API had drifted apart:
 *
 *  - the payment picker offers only real payment sources (§2), which is the same
 *    pure function `recordExpense()` validates against, so the two cannot disagree;
 *  - a member without `finance.expenses_manage` is given no write control at all,
 *    while the register itself stays readable (§3);
 *  - the receipt photo OCR prefills *empty* fields only, degrades to manual entry
 *    on failure, and its suggested account is honoured only when this business
 *    actually owns that code (§13);
 *  - the attached asset's id rides along on the POST, so the photo is evidence
 *    rather than a preview (§7);
 *  - an incomplete form explains itself instead of looking dead (§20).
 *
 * `api()` in `@/app/dashboard/ui` is a thin `fetch` wrapper, so `fetch` is what
 * gets stubbed; jsdom's `FileReader` cannot decode JPEG bytes, so it is replaced
 * with one that resolves asynchronously — the component only needs the data URL.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toPersianDigits } from "@/lib/digits";
import { ExpenseSection } from "./expense-section";
import type { AccountRow, Runner } from "./accounting-manager";
import type { ExpenseListResponse, ExpenseRow } from "./expense-shared";

afterEach(cleanup);

/**
 * The chart the eligibility rules are read against. Codes matter: 1100/1110 are
 * the platform's cash and bank, 1500 inventory and 1200 accounts receivable are
 * the two accounts the audit found people crediting by mistake, and 1220 is
 * recoverable VAT. `parent_id` is what lets a sub-account inherit a meaning.
 */
const ACCOUNTS: AccountRow[] = [
  { id: "acc-cash-1", code: "1100", name: "صندوق", type: "asset", parent_code: null, parent_id: null },
  { id: "acc-cash-2", code: "1101", name: "صندوق شعبهٔ ۲", type: "asset", parent_code: null, parent_id: "acc-cash-1" },
  { id: "acc-bank-1", code: "1110", name: "بانک ملت", type: "asset", parent_code: null, parent_id: null },
  { id: "acc-inventory", code: "1500", name: "موجودی کالا", type: "asset", parent_code: null, parent_id: null },
  { id: "acc-ar", code: "1200", name: "حساب‌های دریافتنی", type: "asset", parent_code: null, parent_id: null },
  { id: "acc-vat", code: "1220", name: "مالیات قابل استرداد", type: "asset", parent_code: null, parent_id: null },
  { id: "acc-expense-1", code: "5001", name: "خرید ملزومات", type: "expense", parent_code: null, parent_id: null },
  { id: "acc-expense-2", code: "5400", name: "اجاره", type: "expense", parent_code: null, parent_id: null },
];

function row(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: "exp-1",
    reference: "EXP-1405-00007",
    expenseDate: "2026-09-01",
    accountCode: "5001",
    accountName: "خرید ملزومات",
    paymentAccountCode: "1100",
    paymentAccountName: "صندوق",
    amount: 1_500_000,
    vatAmount: 0,
    netAmount: 1_500_000,
    vendor: "فروشگاه ملزومات",
    partyId: null,
    partyName: null,
    locationId: null,
    locationName: null,
    memo: "خرید لوازم اداری",
    createdByName: "حمید",
    createdAt: "2026-09-01 10:00:00+00",
    receiptAssetId: null,
    receiptFileName: null,
    status: "active",
    reversedAt: null,
    reversedByName: null,
    reversalExpenseId: null,
    reversalReference: null,
    reversesExpenseId: null,
    reversesExpenseReference: null,
    journalEntryId: "je-1",
    ...overrides,
  };
}

/** The register renders a reference in Persian digits; so must the assertion. */
const ref = (value: string) => toPersianDigits(value);

function listResponse(expenses: ExpenseRow[] = []): ExpenseListResponse {
  return {
    expenses,
    hasMore: false,
    nextCursor: null,
    totalAmount: expenses.reduce((sum, e) => sum + e.netAmount, 0),
    totalVatAmount: 0,
    totalPaidAmount: 0,
    totalCount: expenses.length,
  };
}

const OCR_FIELDS = {
  vendor: "فروشگاه ملزومات",
  expenseDate: "2026-09-01",
  amount: 1_500_000,
  vatAmount: null,
  memo: "خرید لوازم اداری",
  suggestedAccountCode: "5001",
};

const RECEIPT_ASSET = { id: "asset-receipt-1", fileName: "receipt.jpg" };

function json(payload: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => payload };
}

/**
 * One stub for every endpoint the screen touches. `routes` keys are matched in
 * order; anything unhandled is a test bug, so it throws loudly rather than
 * letting a `run()` swallow it.
 */
function stubFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const key = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
    if (!key) throw new Error(`unexpected fetch ${String(url)}`);
    const result = routes[key](init);
    return result ?? json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function receiptFile() {
  return new File(["fake-bytes"], "receipt.jpg", { type: "image/jpeg" });
}

beforeEach(() => {
  vi.stubGlobal(
    "FileReader",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result = "data:image/jpeg;base64,ZmFrZQ==";
      readAsDataURL() {
        setTimeout(() => this.onload?.(), 0);
      }
    },
  );
});

/** Everything the section takes except the four props every test supplies. */
type SectionProps = Partial<Parameters<typeof ExpenseSection>[0]>;

function renderSection(props: Partial<SectionProps> = {}) {
  const run: Runner = async (fn) => {
    const { ok } = (await fn()) as { ok: boolean };
    return ok;
  };
  return render(
    <ExpenseSection
      accounts={ACCOUNTS}
      busy={false}
      run={props.run ?? run}
      refreshKey={0}
      canManageExpenses={props.canManageExpenses}
      canBrowseMedia={props.canBrowseMedia}
    />,
  );
}

/**
 * Chooses the photo and waits for the OCR round trip to have *landed* — the
 * badge is what tells us `receiptAsset` is in state, which is what `submit`
 * reads. Waiting on the file name instead would race the setState.
 */
async function uploadReceipt(expectAsset = true) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [receiptFile()] } });
    await new Promise((r) => setTimeout(r, 0));
  });
  if (expectAsset) await screen.findByText("رسید پیوند شد");
}

/** Opens a picker by its accessible name and picks an option by its label. */
async function pick(name: string, optionLabel: RegExp | string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name }));
  const listbox = await screen.findByRole("listbox");
  const option = await within(listbox).findByRole("option", { name: optionLabel });
  await user.click(option);
}

describe("ExpenseSection — the payment-source rule in the picker (issue #832 §2)", () => {
  it("offers cash and bank, and nothing that is merely an asset", async () => {
    stubFetch({ "/api/ledger/expenses": () => json(listResponse()) });
    renderSection();
    await userEvent.setup().click(screen.getByRole("button", { name: "حساب پرداخت" }));
    const listbox = await screen.findByRole("listbox");
    const labels = within(listbox)
      .getAllByRole("option")
      .map((option) => option.textContent ?? "");
    // 1100 cash, its 1101 sub-account, 1110 bank — the three (plus clearing,
    // absent from this fixture) that a payment may leave from.
    expect(labels.some((l) => l.includes("صندوق"))).toBe(true);
    expect(labels.some((l) => l.includes("صندوق شعبهٔ ۲"))).toBe(true);
    expect(labels.some((l) => l.includes("بانک ملت"))).toBe(true);
    // The audit's four bad credits, none of them offered.
    expect(labels.join(" ")).not.toContain("موجودی کالا");
    expect(labels.join(" ")).not.toContain("حساب‌های دریافتنی");
    expect(labels.join(" ")).not.toContain("مالیات قابل استرداد");
  });

  it("says so in the form when the chart has no payment source to offer", () => {
    stubFetch({ "/api/ledger/expenses": () => json(listResponse()) });
    render(
      <ExpenseSection
        accounts={ACCOUNTS.filter((a) => a.type === "expense")}
        busy={false}
        run={async () => true}
        refreshKey={0}
      />,
    );
    expect(screen.getByText(/دست‌کم یک حساب از نوع «هزینه»/)).toBeTruthy();
    // The register below still renders: a broken chart is not a reason to hide
    // the history somebody came to read.
    expect(screen.getByRole("heading", { name: /هزینه‌ها/ })).toBeTruthy();
  });
});

describe("ExpenseSection — read-only for a member without the capability (issue #832 §3)", () => {
  it("renders no create form, no receipt upload and no submit, but the full list", async () => {
    stubFetch({ "/api/ledger/expenses": () => json(listResponse([row()])) });
    renderSection({ canManageExpenses: false });

    await screen.findByText(ref("EXP-1405-00007"));
    // The form is gone, not merely folded: its heading, its submit, its receipt
    // control and its two pickers are all absent. («پرداخت از» itself stays in the
    // filter bar and the table header — reading is allowed.)
    expect(screen.queryByRole("heading", { name: "ثبت هزینه" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ثبت هزینه" })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "حساب پرداخت" })).toBeNull();
    expect(screen.queryByRole("button", { name: "دسته هزینه" })).toBeNull();
    // The screen says why, in the register's own words, rather than looking
    // half-finished: reading is allowed, and the way to write is named.
    expect(screen.getByText(/فقط می‌توانید فهرست هزینه‌ها را بخوانید/)).toBeTruthy();
    // Readable: the row's accounts, its total, its filters.
    // The row's account, in the desktop cell *and* the mobile card heading: the
    // read-only register loses nothing on a phone (§22 — a fact shown in only one
    // layout is a fact half the team never sees).
    expect(screen.getAllByText(/۵۰۰۱ خرید ملزومات/)).toHaveLength(2);
    expect(screen.getByLabelText(/از تاریخ/)).toBeTruthy();
  });

  it("keeps the controls when the permission set could not be read", () => {
    // `undefined` means "the shell has not resolved effective permissions", not
    // "denied": an accountant must not lose the form to a failed fetch.
    stubFetch({ "/api/ledger/expenses": () => json(listResponse()) });
    renderSection({ canManageExpenses: undefined });
    expect(screen.getByRole("button", { name: "ثبت هزینه" })).toBeTruthy();
  });

  it("still lists and filters — the register is readable without the capability", async () => {
    const fetchMock = stubFetch({ "/api/ledger/expenses": () => json(listResponse([row()])) });
    renderSection({ canManageExpenses: false });
    await screen.findByText(ref("EXP-1405-00007"));
    const before = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText("شرح، طرف حساب، شمارهٔ سند یا نام/کد حساب…"), {
      target: { value: "ملزومات" },
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    // Every read still carries the filter, so the list the member sees is the
    // list the server computed — not a client-side slice of it (§9 of the issue).
    const lastUrl = String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]);
    expect(lastUrl).toContain("q=");
  });
});

describe("ExpenseSection — receipt photo OCR (issue #832 §7, §13)", () => {
  it("uploads a receipt photo, extracts fields, and prefills empty ones without overwriting typed values", async () => {
    stubFetch({
      "/api/ledger/expenses": () => json(listResponse()),
      "/api/ai/receipt-ocr": () => json({ fields: OCR_FIELDS, asset: RECEIPT_ASSET }),
    });

    renderSection();
    // Type a vendor first: extraction must not speak over a person's typing.
    fireEvent.change(screen.getByPlaceholderText("نام طرف حساب"), { target: { value: "فروشگاه خودم" } });
    await uploadReceipt();
    expect((screen.getByPlaceholderText("نام طرف حساب") as HTMLInputElement).value).toBe("فروشگاه خودم");
    expect((screen.getByPlaceholderText("شرح و دلیل ثبت هزینه") as HTMLInputElement).value).toBe("خرید لوازم اداری");
    // 1,500,000 Rial → 150,000 Toman (the default display unit with no
    // MoneyProvider), through PersianNumberInput's own digit formatting.
    expect((screen.getByPlaceholderText("۰") as HTMLInputElement).value).toBe("۱۵۰٬۰۰۰");
    // The OCR's suggested code (5001) is one this business owns, so it is chosen.
    expect(screen.getByRole("button", { name: "دسته هزینه" }).textContent).toContain("خرید ملزومات");
  });

  it("leaves the category alone when the suggested code is not in this tenant's chart", async () => {
    stubFetch({
      "/api/ledger/expenses": () => json(listResponse()),
      "/api/ai/receipt-ocr": () =>
        json({ fields: { ...OCR_FIELDS, suggestedAccountCode: "5100" }, asset: RECEIPT_ASSET }),
    });
    renderSection();
    await uploadReceipt();
    // 5100 is the old hard-coded F&B «بهای تمام‌شده» code. Nothing may be
    // pre-selected from a chart this business does not have.
    expect(screen.getByRole("button", { name: "دسته هزینه" }).textContent).not.toContain("بهای تمام‌شده");
    expect(screen.getByRole("button", { name: "دسته هزینه" }).textContent).not.toContain("خرید ملزومات");
  });

  it("shows an error and leaves the form untouched when extraction fails", async () => {
    stubFetch({
      "/api/ledger/expenses": () => json(listResponse()),
      "/api/ai/receipt-ocr": () => json({ error: "receipt_unreadable", message: "متن رسید خوانا نبود." }, 422),
    });
    renderSection();
    await uploadReceipt(false);
    await screen.findByText("متن رسید خوانا نبود.");
    expect((screen.getByPlaceholderText("نام طرف حساب") as HTMLInputElement).value).toBe("");
    // Manual entry is still open — a failed OCR must never lock the form.
    expect((screen.getByRole("button", { name: "ثبت هزینه" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("includes the extracted asset's id as receiptAssetId when the expense is submitted", async () => {
    const fetchMock = stubFetch({
      "/api/ledger/expenses": (init) =>
        init?.method === "POST"
          ? json({ expense: row() }, 201)
          : json(listResponse()),
      "/api/ai/receipt-ocr": () => json({ fields: OCR_FIELDS, asset: RECEIPT_ASSET }),
    });
    renderSection();

    // The OCR prefill covers everything except the payment account (a receipt
    // photo says nothing about which till paid it), so pick one through the real
    // picker — which is also the proof that §2's rule is what fills the list.
    await pick("حساب پرداخت", /۱۱۰۰ — صندوق|1100 — صندوق/);
    await uploadReceipt();

    const form = document.querySelector("form") as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
      await new Promise((r) => setTimeout(r, 0));
    });

    // The OCR call is a POST too, so match the endpoint *and* the method.
    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/ledger/expenses" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(post, "a POST to the expenses endpoint").toBeTruthy();
    const body = JSON.parse(String((post?.[1] as RequestInit).body));
    expect(body.receiptAssetId).toBe("asset-receipt-1");
    expect(body.paymentAccountId).toBe("acc-cash-1");
    expect(body.accountId).toBe("acc-expense-1");
    expect(body.amount).toBe(1_500_000);
  });
});

describe("ExpenseSection — the register's own honesty (issue #832 §9, §20, §21)", () => {
  it("names the first thing to fix instead of disabling the button", async () => {
    stubFetch({ "/api/ledger/expenses": () => json(listResponse()) });
    renderSection();
    const submit = screen.getByRole("button", { name: "ثبت هزینه" });
    // Clickable while incomplete — that is the point (§20) — and the click says why.
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await userEvent.setup().click(submit);
    const hint = await screen.findByRole("status");
    expect(hint.textContent).toContain("دسته هزینه را انتخاب کنید.");
    expect(fetch).not.toHaveBeenCalledWith("/api/ledger/expenses", expect.objectContaining({ method: "POST" }));
  });

  it("shows the server's totals over the whole filtered set, not the page's sum", async () => {
    const expenses = [row(), row({ id: "exp-2", reference: "EXP-1405-00008", netAmount: 500_000, amount: 500_000 })];
    stubFetch({
      "/api/ledger/expenses": () => json({ ...listResponse(expenses), totalAmount: 99_000_000, totalCount: 412 }),
    });
    renderSection();
    await screen.findByText(ref("EXP-1405-00008"));
    // 99,000,000 Rial displayed in the default Toman unit — the server's number,
    // which is nine hundred times the two rows on this page.
    // One element, unit and all: the footer prints the server's figure rather
    // than the page's, and that is the whole assertion.
    expect(screen.getByText(/۹٬۹۰۰٬۰۰۰ تومان/)).toBeTruthy();
    // …and the count says the set is bigger than the page, which is the whole
    // difference between a register and a truncated list.
    expect(document.body.textContent).toContain("۴۱۲");
  });

  it("asks the server for the next page rather than slicing what it already has", async () => {
    const expenses = Array.from({ length: 3 }, (_, i) =>
      row({ id: `exp-${i}`, reference: `EXP-1405-${String(i).padStart(5, "0")}` }),
    );
    const fetchMock = stubFetch({
      "/api/ledger/expenses": () =>
        json({ ...listResponse(expenses), hasMore: true, nextCursor: "2026-09-01|2026-09-01 10:00:00+00|exp-2", totalCount: 412 }),
    });
    renderSection();
    await screen.findByText(ref("EXP-1405-00000"));
    const more = await screen.findByRole("button", { name: /نمایش بیشتر/ });
    const before = fetchMock.mock.calls.length;
    await userEvent.setup().click(more);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    const lastUrl = String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]);
    expect(lastUrl).toContain("cursor=");
    expect(lastUrl).toContain("2026-09-01");
  });

  it("labels a reversed expense and a reversal, so the register reads like the ledger", async () => {
    const expenses = [
      row({ id: "exp-r", reference: "EXP-1405-00009", status: "reversed", reversalReference: "EXP-1405-00010" }),
      row({
        id: "exp-v",
        reference: "EXP-1405-00010",
        status: "reversal",
        reversesExpenseReference: "EXP-1405-00009",
        amount: -1_500_000,
        netAmount: -1_500_000,
      }),
    ];
    stubFetch({ "/api/ledger/expenses": () => json(listResponse(expenses)) });
    renderSection();
    await screen.findByText(ref("EXP-1405-00009"));
    // The three states are words on the screen, not a flag in the payload.
    // Desktop table *and* mobile cards (§22) — every audit fact twice, once per layout.
    expect(screen.getAllByText("برگشت خورده").length).toBeGreaterThan(0);
    expect(screen.getAllByText("سند برگشت").length).toBeGreaterThan(0);
    // The original is still labelled «فعال»-free — it is «برگشت خورده», and the
    // reversal that explains it carries the reference back to it.
    // The pair names each other: the original carries a link to the reversal
    // that explains it, which is what makes a correction auditable rather than a
    // second unexplained row (§1).
    // The mobile card line carries the reference inside a longer string, and the
    // desktop table carries it alone — the point is simply that the pairing text
    // is on screen, on the row that was reversed.
    expect(document.body.textContent).toContain(ref("EXP-1405-00009"));
    expect(document.body.textContent).toContain(ref("EXP-1405-00010"));
  });
});
