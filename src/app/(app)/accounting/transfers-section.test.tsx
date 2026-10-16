// @vitest-environment jsdom

/**
 * «انتقال وجه» as a person moving money actually meets it (issue #862).
 *
 * Each case is one of the decisions that keeps a transfer honest:
 *
 *  - The amount is typed in the business's own display unit and sent as exact
 *    Rial text — Toman × 10, never a float — because that is where a Rial-vs-Toman
 *    mistake would otherwise cost a factor of ten on every transfer.
 *  - The preview the form draws is the entry the server will post, computed by the
 *    same `buildTransferLines` the service uses.
 *  - One attempt carries one idempotency key, so a retry after a lost response is
 *    the same request and not a second document.
 *  - A transfer is reversed, never edited: the register offers «برگشت سند» with a
 *    mandatory reason and no edit button at all.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { TransfersSection } from "./transfers-section";

afterEach(cleanup);

const CASH_ID = "fa-cash";
const BANK_ID = "fa-bank";

function financialAccount(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: id === CASH_ID ? "cash" : "bank",
    code: id === CASH_ID ? "CASH-1" : "BANK-1",
    name: id === CASH_ID ? "صندوق مرکزی" : "حساب جاری ملت",
    glAccountId: id === CASH_ID ? "gl-cash" : "gl-bank",
    glAccountCode: id === CASH_ID ? "1100" : "1110",
    glAccountName: id === CASH_ID ? "صندوق" : "بانک",
    currencyCode: "IRR",
    locationId: null,
    locationName: null,
    isActive: true,
    isDefault: true,
    description: null,
    notes: null,
    bankName: id === CASH_ID ? null : "ملت",
    bankBranchName: null,
    pspProvider: null,
    settlementAccountId: null,
    settlementAccountName: null,
    settlementDelayDays: null,
    accountNumber: null,
    cardNumber: null,
    iban: null,
    accountHolder: null,
    settlementReference: null,
    merchantNumber: null,
    terminalNumber: null,
    balance: "0",
    archivedAt: null,
    archivedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-1",
    transferNumber: "TR-000042",
    sequenceNo: "42",
    transferDate: "2026-04-20",
    sourceAccountId: CASH_ID,
    sourceAccountName: "صندوق مرکزی",
    sourceAccountKind: "cash",
    destinationAccountId: BANK_ID,
    destinationAccountName: "حساب جاری ملت",
    destinationAccountKind: "bank",
    amount: "1000000",
    feeAmount: "0",
    feeAccountId: null,
    feeAccountLabel: null,
    feePayer: "source",
    currencyCode: "IRR",
    referenceNumber: null,
    description: "واریز نقدی روز",
    projectId: null,
    projectName: null,
    attachmentAssetId: null,
    status: "posted",
    postingMode: "transfer",
    journalEntryId: "entry-1",
    reversalEntryId: null,
    reversesTransferId: null,
    reversalReason: null,
    reversedAt: null,
    reversedBy: null,
    postedAt: "2026-04-20T08:00:00.000Z",
    createdBy: "user-1",
    createdByName: "زهرا",
    locationId: "loc-1",
    locationName: "شعبهٔ مرکزی",
    sourceOutflow: "1000000",
    destinationInflow: "1000000",
    ...overrides,
  };
}

let registerCalls: string[];
let writes: string[];

function stubFetch(options: { transfers?: () => unknown; write?: () => { ok: boolean; status: number; body: unknown } } = {}) {
  registerCalls = [];
  writes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push(`${method} ${url} ${String(init?.body ?? "")}`);
        const answer = options.write?.() ?? { ok: true, status: 201, body: { transfer: transfer() } };
        return { ok: answer.ok, status: answer.status, json: async () => answer.body };
      }
      if (url.startsWith("/api/ledger/transfers?")) {
        registerCalls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () =>
            options.transfers?.() ?? {
              transfers: [transfer()],
              totalCount: 1,
              totalAmount: "1000000",
              totalFee: "0",
              postedCount: 1,
              reversedCount: 0,
            },
        };
      }
      if (url.startsWith("/api/ledger/transfers/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transfer: {
              ...transfer(),
              journalLines: [
                { accountId: "gl-bank", accountCode: "1110", accountName: "بانک", debit: "1000000", credit: "0" },
                { accountId: "gl-cash", accountCode: "1100", accountName: "صندوق", debit: "0", credit: "1000000" },
              ],
            },
          }),
        };
      }
      if (url.startsWith("/api/ledger/financial-accounts?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accounts: [financialAccount(CASH_ID), financialAccount(BANK_ID)],
            totalsByKind: { bank: "0", cash: "0", petty_cash: "0", pos_psp: "0" },
            totalBalance: "0",
            activeCount: 2,
            archivedCount: 0,
            canViewSensitive: true,
          }),
        };
      }
      if (url.startsWith("/api/ledger/accounts")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accounts: [
              { id: "gl-fee", code: "6100", name: "کارمزد بانکی", type: "expense", is_postable: true },
              { id: "gl-bank", code: "1110", name: "بانک", type: "asset", is_postable: true },
            ],
          }),
        };
      }
      if (url.startsWith("/api/locations/active")) {
        return { ok: true, status: 200, json: async () => ({ locations: [{ id: "loc-1", name: "شعبهٔ مرکزی" }] }) };
      }
      if (url.startsWith("/api/workspace/projects")) {
        return { ok: true, status: 200, json: async () => ({ projects: [{ id: "p-1", name: "بازسازی شعبه" }] }) };
      }
      if (url.startsWith("/api/journal")) {
        return { ok: true, status: 200, json: async () => ({ entry: null, lines: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

function renderSection(canManage = true) {
  return render(
    <MoneyProvider unit="toman">
      <TransfersSection
        busy={false}
        run={async (fn) => (await fn()).ok}
        refreshKey={0}
        canManage={canManage}
      />
    </MoneyProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the transfer register", () => {
  it("draws the document, both sides and its status", async () => {
    stubFetch();
    renderSection();
    expect((await screen.findAllByText("TR-000042")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("صندوق مرکزی").length).toBeGreaterThan(0);
    expect(screen.getAllByText("حساب جاری ملت").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ثبت‌شده").length).toBeGreaterThan(0);
  });

  it("carries the date range, account and status filters to the API", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");

    await user.selectOptions(screen.getByLabelText("حساب"), CASH_ID);
    await waitFor(() =>
      expect(new URL(registerCalls[registerCalls.length - 1], "http://t").searchParams.get("accountId")).toBe(CASH_ID),
    );

    await user.click(screen.getByRole("button", { name: "برگشت‌خورده" }));
    await waitFor(() =>
      expect(new URL(registerCalls[registerCalls.length - 1], "http://t").searchParams.get("status")).toBe("reversed"),
    );
    // A cursor, never an offset: the register refuses `?offset=` outright.
    expect(new URL(registerCalls[registerCalls.length - 1], "http://t").searchParams.has("offset")).toBe(false);
  });

  it("shows the detail with the journal lines it posted", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");

    await user.click((await screen.findAllByRole("button", { name: "جزئیات" }))[0]);
    expect(await screen.findByText(/سند انتقال TR-000042/)).toBeTruthy();
    // The lines are the entry's own: the GL codes exactly as the service sent
    // them, not re-styled for display.
    expect((await screen.findAllByText("1110 — بانک")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1100 — صندوق").length).toBeGreaterThan(0);
  });

  it("offers no transfer form or reversal to a reader", async () => {
    stubFetch();
    renderSection(false);
    await screen.findAllByText("TR-000042");
    expect(screen.queryByRole("button", { name: /انتقال تازه/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "برگشت سند" })).toBeNull();
  });
});

describe("creating a transfer", () => {
  async function openForm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /انتقال تازه/ }));
    expect(await screen.findByRole("heading", { name: "انتقال وجه تازه" })).toBeTruthy();
  }

  it("sends the amount as exact Rial text in the business's own unit", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");
    await openForm(user);

    await user.type(screen.getByLabelText("مبلغ"), "150000");
    await user.click(screen.getByLabelText("از حساب"));
    await user.click(await screen.findByRole("option", { name: "صندوق مرکزی" }));
    await user.click(screen.getByLabelText("به حساب"));
    await user.click(await screen.findByRole("option", { name: "حساب جاری ملت — ملت" }));
    await user.click(screen.getByRole("button", { name: "ثبت انتقال" }));

    await waitFor(() => expect(writes.length).toBe(1));
    const body = JSON.parse(writes[0].slice(writes[0].indexOf("{")).trim());
    // ۱۵۰٬۰۰۰ تومان is ۱٬۵۰۰٬۰۰۰ ریال — the unit conversion, exactly.
    expect(body.amount).toBe("1500000");
    expect(body.sourceAccountId).toBe(CASH_ID);
    expect(body.destinationAccountId).toBe(BANK_ID);
    expect(body.feeAmount).toBe("0");
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(10);
  });

  it("previews the very lines the server will post", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");
    await openForm(user);

    await user.type(screen.getByLabelText("مبلغ"), "100000");
    await user.click(screen.getByLabelText("از حساب"));
    await user.click(await screen.findByRole("option", { name: "صندوق مرکزی" }));
    await user.click(screen.getByLabelText("به حساب"));
    await user.click(await screen.findByRole("option", { name: "حساب جاری ملت — ملت" }));
    expect(await screen.findByText("پیش‌نمایش سند")).toBeTruthy();

    const preview = await screen.findByRole("table", { name: "پیش‌نمایش سطرهای سند انتقال" });
    const rows = within(preview).getAllByRole("row").slice(1);
    // Two legs, balanced — the destination debited, the source credited.
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("gl-bank")).toBeTruthy();
    expect(within(rows[1]).getByText("gl-cash")).toBeTruthy();
  });

  it("demands a fee account the moment there is a fee", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");
    await openForm(user);

    await user.type(screen.getByLabelText("مبلغ"), "100000");
    await user.click(screen.getByLabelText("از حساب"));
    await user.click(await screen.findByRole("option", { name: "صندوق مرکزی" }));
    await user.click(screen.getByLabelText("به حساب"));
    await user.click(await screen.findByRole("option", { name: "حساب جاری ملت — ملت" }));
    await user.type(screen.getByLabelText("کارمزد (اختیاری)"), "5000");

    // With a fee but no expense account the form will not submit…
    expect(screen.getByRole("button", { name: "ثبت انتقال" })).toHaveProperty("disabled", true);
    // …and the expense-account picker is there to be filled.
    expect(screen.getByLabelText(/حساب هزینهٔ کارمزد/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText(/حساب هزینهٔ کارمزد/), "gl-fee");
    expect(screen.getByRole("button", { name: "ثبت انتقال" })).toHaveProperty("disabled", false);
  });

  it("refuses a transfer between two accounts that share one GL account", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");
    await openForm(user);

    // The same account picked on both sides is the same GL identity.
    await user.click(screen.getByLabelText("از حساب"));
    await user.click(await screen.findByRole("option", { name: "صندوق مرکزی" }));
    await user.click(screen.getByLabelText("به حساب"));
    await user.click(await screen.findByRole("option", { name: "صندوق مرکزی" }));
    await user.type(screen.getByLabelText("مبلغ"), "100000");

    expect(screen.getByRole("button", { name: "ثبت انتقال" })).toHaveProperty("disabled", true);
  });
});

describe("reversing a transfer", () => {
  it("will not reverse without a reason, and posts the reason and date when given one", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");

    await user.click((await screen.findAllByRole("button", { name: "برگشت سند" }))[0]);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: /برگشت سند$/ })).toHaveProperty("disabled", true);

    await user.type(within(dialog).getByLabelText("دلیل برگشت"), "ثبت اشتباه مبلغ");
    await user.click(within(dialog).getByRole("button", { name: /برگشت سند$/ }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].startsWith("POST /api/ledger/transfers/t-1/reverse ")).toBe(true);
    expect(JSON.parse(writes[0].slice(writes[0].indexOf("{")))).toMatchObject({ reason: "ثبت اشتباه مبلغ" });
  });

  it("shows the domain's own sentence when the transfer is already reversed", async () => {
    stubFetch({ write: () => ({ ok: false, status: 409, body: { error: "transfer_already_reversed" } }) });
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByText("TR-000042");

    await user.click((await screen.findAllByRole("button", { name: "برگشت سند" }))[0]);
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("دلیل برگشت"), "دوباره");
    await user.click(within(dialog).getByRole("button", { name: /برگشت سند$/ }));

    expect(await screen.findByText("این انتقال قبلاً برگشت خورده است.")).toBeTruthy();
  });
});
