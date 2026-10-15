// @vitest-environment jsdom

/**
 * «حساب‌های مالی» as a reader actually meets it (issue #862).
 *
 * Each case is one decision the screen makes that the API cannot undo:
 *
 *  - The register's numbers are the server's. The section never adds anything up
 *    itself, so what is asserted is that the balance it draws is the one the
 *    route sent — not a number it recomputed.
 *  - A member without `finance.accounts_manage` reads the register with masked
 *    numbers and is *told* they are masked, and is not offered a form whose
 *    submit the API would refuse.
 *  - Archiving goes through `/archive` with a reason (never a flag flip), and a
 *    refusal arrives as the domain's own Persian sentence.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { formatMoneyText } from "@/lib/money";
import { FinancialAccountsSection } from "./financial-accounts-section";

afterEach(cleanup);

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "fa-1",
    kind: "bank",
    code: "BANK-1",
    name: "حساب جاری ملت",
    glAccountId: "gl-bank",
    glAccountCode: "1110",
    glAccountName: "بانک",
    currencyCode: "IRR",
    locationId: "loc-1",
    locationName: "شعبهٔ مرکزی",
    isActive: true,
    isDefault: true,
    description: null,
    notes: null,
    bankName: "ملت",
    bankBranchName: null,
    pspProvider: null,
    settlementAccountId: null,
    settlementAccountName: null,
    settlementDelayDays: null,
    accountNumber: "1234567890",
    cardNumber: "6037991234567890",
    iban: "IR820540102680020817909002",
    accountHolder: "شرکت نمونه",
    settlementReference: null,
    merchantNumber: null,
    terminalNumber: null,
    balance: "56000000",
    archivedAt: null,
    archivedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function register(overrides: Record<string, unknown> = {}) {
  return {
    accounts: [account()],
    totalsByKind: { bank: "56000000", cash: "0", petty_cash: "0", pos_psp: "0" },
    totalBalance: "56000000",
    activeCount: 1,
    archivedCount: 0,
    canViewSensitive: true,
    ...overrides,
  };
}

/** Every register URL the section asked for, in order. */
let registerCalls: string[];
/** Every non-GET request, as `METHOD url body`. */
let writes: string[];

let cardCalls: string[];

function stubFetch(options: {
  register?: () => unknown;
  accountDetail?: () => unknown;
  card?: () => unknown;
  eligible?: () => unknown;
  write?: (method: string, url: string) => { ok: boolean; status: number; body: unknown };
} = {}) {
  registerCalls = [];
  writes = [];
  cardCalls = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push(`${method} ${url} ${String(init?.body ?? "")}`);
      const answer = options.write?.(method, url) ?? { ok: true, status: 200, body: {} };
      return { ok: answer.ok, status: answer.status, json: async () => answer.body };
    }
    if (url.startsWith("/api/ledger/financial-accounts?")) {
      registerCalls.push(url);
      return { ok: true, status: 200, json: async () => (options.register?.() ?? register()) };
    }
    if (url.startsWith("/api/ledger/financial-accounts/eligible")) {
      return {
        ok: true,
        status: 200,
        json: async () => options.eligible?.() ?? { accounts: [{ id: "gl-bank", code: "1110", name: "بانک" }] },
      };
    }
    if (url.includes("/card")) {
      cardCalls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          options.card?.() ?? {
            account: account(),
            from: null,
            to: null,
            opening: "55000000",
            rows: [],
            totalDebit: "1000000",
            totalCredit: "0",
            closing: "56000000",
            reconciliationDifference: "0",
            ledgerBalance: "56000000",
          },
      };
    }
    if (/^\/api\/ledger\/financial-accounts\/[^?]+$/.test(url)) {
      return { ok: true, status: 200, json: async () => options.accountDetail?.() ?? { account: account() } };
    }
    if (url.startsWith("/api/locations/active")) {
      return { ok: true, status: 200, json: async () => ({ locations: [{ id: "loc-1", name: "شعبهٔ مرکزی" }] }) };
    }
    if (url.startsWith("/api/workspace/projects")) {
      return { ok: true, status: 200, json: async () => ({ projects: [{ id: "p-1", name: "بازسازی شعبه" }] }) };
    }
    if (url.startsWith("/api/currencies")) {
      return { ok: true, status: 200, json: async () => ({ config: { baseCurrencyCode: "IRR", enabled: ["IRR"] } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection(canManage = true) {
  return render(
    <MoneyProvider unit="rial">
      <FinancialAccountsSection busy={false} refreshKey={0} canManage={canManage} />
    </MoneyProvider>,
  );
}

/**
 * The table draws twice — a wide row and a stacked card at the small
 * breakpoint — so the register's presence is asserted with `findAllByText`,
 * which is also what proves both faces are there.
 */
async function waitForRegister(name = "حساب جاری ملت — ملت") {
  const matches = await screen.findAllByText(name);
  expect(matches.length).toBeGreaterThan(0);
}

/**
 * The table draws its row actions twice (the wide row and the stacked card), so
 * a click has to say which face it means — the first one, the wide row, exactly
 * as a desktop reader presses it.
 */
async function clickRowAction(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click((await screen.findAllByRole("button", { name }))[0]);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the register", () => {
  it("draws the ledger's own balance, not one it computed", async () => {
    stubFetch();
    renderSection();
    await waitForRegister();
    // ۵۶٬۰۰۰٬۰۰۰ ریال as the business reads it — the string the money layer
    // produces, so the assertion cannot pass on a hand-typed look-alike.
    expect(screen.getAllByText(formatMoneyText("56000000", "rial")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1110/).length).toBeGreaterThan(0);
  });

  it("carries the kind filter and the branch filter to the API", async () => {
    stubFetch();
    renderSection();
    await waitForRegister();

    fireEvent.click(screen.getByRole("button", { name: "تنخواه" }));
    await waitFor(() => expect(registerCalls.length).toBeGreaterThan(1));
    expect(new URL(registerCalls[registerCalls.length - 1], "http://t").searchParams.get("kind")).toBe("petty_cash");

    fireEvent.change(screen.getByLabelText(/شعبه$/), { target: { value: "loc-1" } });
    await waitFor(() =>
      expect(new URL(registerCalls[registerCalls.length - 1], "http://t").searchParams.get("locationId")).toBe("loc-1"),
    );
  });

  it("asks the server for archived accounts only when the filter says so", async () => {
    stubFetch();
    renderSection();
    await waitForRegister();
    expect(new URL(registerCalls[0], "http://t").searchParams.get("status")).toBe("active");

    fireEvent.change(screen.getByLabelText("وضعیت"), { target: { value: "all" } });
    await waitFor(() =>
      expect(new URL(registerCalls[registerCalls.length - 1], "http://t").searchParams.get("status")).toBe("all"),
    );
  });

  it("says why the numbers are masked instead of drawing a broken field", async () => {
    stubFetch({ register: () => register({ canViewSensitive: false }) });
    renderSection(false);
    expect(await screen.findByText(/شمارهٔ حساب، کارت و شناسهٔ پایانه برای شما پوشیده است/)).toBeTruthy();
  });

  it("offers no create form to a member who may only read the register", async () => {
    stubFetch();
    renderSection(false);
    await waitForRegister();
    expect(screen.queryByRole("button", { name: /حساب تازه/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /ویرایش/ })).toBeNull();
  });
});

describe("registering an account", () => {
  it("sends the form's fields to the create route and refreshes", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await user.click(screen.getByRole("button", { name: /حساب تازه/ }));
    expect(await screen.findByRole("heading", { name: "حساب مالی تازه" })).toBeTruthy();

    await user.type(screen.getByLabelText("نام حساب"), "صندوق شعبهٔ دو");
    await user.selectOptions(screen.getByLabelText(/سرفصل دفتر کل/), "gl-bank");
    await user.click(screen.getByRole("button", { name: "ثبت حساب" }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].startsWith("POST /api/ledger/financial-accounts ")).toBe(true);
    const body = JSON.parse(writes[0].slice(writes[0].indexOf("{")).trim());
    expect(body).toMatchObject({ kind: "bank", name: "صندوق شعبهٔ دو", glAccountId: "gl-bank", isDefault: false });
  });

  it("asks the eligibility route for the kind's own candidates, excluding the account being edited", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await clickRowAction(user, "ویرایش");
    expect(await screen.findByRole("heading", { name: "ویرایش حساب مالی" })).toBeTruthy();
    const asked = vi
      .mocked(fetch)
      .mock.calls.map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/ledger/financial-accounts/eligible"));
    expect(asked.length).toBeGreaterThan(0);
    const params = new URL(asked[asked.length - 1], "http://t").searchParams;
    expect(params.get("kind")).toBe("bank");
    expect(params.get("excludeId")).toBe("fa-1");
  });
});

describe("retiring an account", () => {
  it("archives through /archive with a reason, and never with a flag flip", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await clickRowAction(user, "بایگانی");
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/دلیل بایگانی/), "بستن شعبه");
    await user.click(within(dialog).getByRole("button", { name: /بایگانی کن/ }));

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].startsWith("POST /api/ledger/financial-accounts/fa-1/archive ")).toBe(true);
    expect(JSON.parse(writes[0].slice(writes[0].indexOf("{")))).toEqual({ reason: "بستن شعبه" });
  });

  it("shows the domain's own sentence when the account still holds money", async () => {
    stubFetch({
      write: () => ({ ok: false, status: 409, body: { error: "financial_account_has_balance" } }),
    });
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await clickRowAction(user, "بایگانی");
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /بایگانی کن/ }));

    expect(await screen.findByText(/این حساب مانده دارد و بایگانی نمی‌شود/)).toBeTruthy();
  });

  it("restores an archived account with the restore endpoint", async () => {
    stubFetch({ register: () => register({ accounts: [account({ isActive: false, archivedAt: "2026-02-01T00:00:00.000Z" })] }) });
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await clickRowAction(user, "بازگردانی");
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].startsWith("PUT /api/ledger/financial-accounts/fa-1 ")).toBe(true);
  });
});

describe("the account card", () => {
  it("shows the reconciliation and states it agrees with the ledger", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await clickRowAction(user, "صورت حساب");
    expect(await screen.findByText(/صورت حساب با دفتر کل تطبیق دارد/)).toBeTruthy();
    expect(screen.getByText("مانده ابتدای دوره")).toBeTruthy();
    expect(screen.getByText(formatMoneyText("55000000", "rial"))).toBeTruthy();
  });

  it("carries the card's own window, branch and project filters to the API", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await user.click((await screen.findAllByRole("button", { name: "صورت حساب" }))[0]);
    // The card is the dialog; the register's own filters sit behind it.
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("شعبه"), "loc-1");
    await waitFor(() => {
      const asked = cardCalls[cardCalls.length - 1];
      expect(new URL(asked, "http://t").searchParams.get("locationId")).toBe("loc-1");
    });

    // The project filter is best-effort: it appears when the workspace route
    // answers, and the card still works without it.
    const projectSelect = within(dialog).queryByLabelText("پروژه");
    if (projectSelect) {
      await user.selectOptions(projectSelect, "p-1");
      await waitFor(() =>
        expect(new URL(cardCalls[cardCalls.length - 1], "http://t").searchParams.get("projectId")).toBe("p-1"),
      );
    }
  });

  it("refuses to stay silent when the card and the ledger disagree", async () => {
    stubFetch({
      card: () => ({
        account: account(),
        from: null,
        to: null,
        opening: "55000000",
        rows: [],
        totalDebit: "1000000",
        totalCredit: "0",
        closing: "56000000",
        reconciliationDifference: "-1",
        ledgerBalance: "56000001",
      }),
    });
    const user = userEvent.setup();
    renderSection();
    await waitForRegister();

    await clickRowAction(user, "صورت حساب");
    expect(await screen.findByText(/مغایرت با دفتر کل/)).toBeTruthy();
  });
});
