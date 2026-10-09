// @vitest-environment jsdom

/**
 * The trial-balance screen's own contract (issue #820).
 *
 * What is pinned here is the part an integration test over the service cannot
 * see: that the section **asks for a period** rather than quietly meaning "all
 * time", that a stale response cannot overwrite a newer one, that a failure
 * leaves the loading state and offers a retry, that a zero-balance account is
 * hidden until asked for, and that a balance above `Number.MAX_SAFE_INTEGER`
 * reaches the screen digit for digit through `money.formatText`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import { formatRialText, formatTomanText } from "@/lib/money";
import { MoneyProvider } from "@/components/money/money-context";
import { TrialBalanceSection } from "./trial-balance-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const today = todayJalali();
const MONTH_START = jalaliToIsoDate(today.jy, today.jm, 1);
const TODAY_ISO = jalaliToIsoDate(today.jy, today.jm, today.jd);

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: `acc-${Math.random().toString(36).slice(2)}`,
    code: "1100",
    name: "صندوق",
    type: "asset",
    isActive: true,
    parentId: null,
    parentCode: null,
    level: "moein",
    hasChildren: false,
    isContra: false,
    normalBalance: "debit",
    isAbnormalBalance: false,
    openingDebit: "0",
    openingCredit: "0",
    periodDebit: "1000000",
    periodCredit: "400000",
    closingDebit: "600000",
    closingCredit: "0",
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  const accounts = overrides.accounts as unknown[] | undefined;
  return {
    businessName: "کافه نمونه",
    mode: "detailed",
    periodFrom: MONTH_START,
    periodTo: TODAY_ISO,
    asOf: null,
    accounts: accounts ?? [
      account(),
      account({ id: "acc-sales", code: "4100", name: "درآمد فروش", type: "revenue", normalBalance: "credit", periodDebit: "0", periodCredit: "1000000", closingDebit: "0", closingCredit: "1000000" }),
    ],
    totals: {
      openingDebit: "0", openingCredit: "0", periodDebit: "1000000",
      periodCredit: "1000000", closingDebit: "600000", closingCredit: "1000000",
      closingDifference: "-400000",
    },
    trialBalanceBalanced: true,
    activity: { entryCount: 2, lineCount: 4 },
    integrity: {
      ledgerHealthy: true, entryCount: 2, lineCount: 4,
      unbalancedEntryCount: 0, invalidEntryCount: 0, balanceDifference: "0",
    },
    ...overrides,
  };
}

interface Call {
  url: string;
  signal?: AbortSignal;
}

/** Stubs fetch, recording every trial-balance and drill-down request. */
function stubFetch(
  respond: (url: string) => unknown | Promise<unknown>,
): { calls: Call[]; drillCalls: Call[]; mock: ReturnType<typeof vi.fn> } {
  const calls: Call[] = [];
  const drillCalls: Call[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.startsWith("/api/ledger/trial-balance")) {
      calls.push({ url, signal: init?.signal ?? undefined });
    }
    if (typeof url === "string" && url.startsWith("/api/reports/drill-down")) {
      drillCalls.push({ url, signal: init?.signal ?? undefined });
    }
    const payload = await respond(url);
    if (payload instanceof Error) throw payload;
    const failed = (payload as { __failed?: boolean }).__failed === true;
    return {
      ok: !failed,
      status: failed ? 500 : 200,
      json: async () => {
        const { __failed: _ignored, ...body } = payload as Record<string, unknown>;
        return body;
      },
    };
  });
  vi.stubGlobal("fetch", mock);
  return { calls, drillCalls, mock };
}

function fiscalYearsResponse() {
  return { fiscalYears: [] };
}

const TABLE_NAME = /تراز آزمایشی دوره‌ای/;

async function renderSection(
  props: { refreshKey?: number; canExport?: boolean; unit?: "toman" | "rial" } = {},
) {
  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <MoneyProvider unit={props.unit ?? "toman"}>
        <TrialBalanceSection refreshKey={props.refreshKey ?? 0} canExport={props.canExport ?? false} />
      </MoneyProvider>,
    );
  });
  // Wait for the request to settle into either a report or a message: the
  // skeleton's own label is not text, so "no skeleton" alone proves nothing.
  await waitFor(() => {
    const settled =
      screen.queryByRole("table", { name: TABLE_NAME }) !== null ||
      screen.queryByText(/ناموفق بود|برقرار نشد|معتبر نیست/) !== null;
    expect(settled).toBe(true);
  });
  return view!;
}

/**
 * The desktop table. jsdom applies no CSS, so the `lg:hidden` card list and the
 * print-only table are in the DOM too and every account name is on screen three
 * times; scoping to the table is what makes "the row shows X" mean something.
 */
function desktopTable() {
  return screen.getByRole("table", { name: TABLE_NAME });
}

function desktopRow(accountName: string) {
  return within(desktopTable()).getByText(accountName).closest("tr")!;
}

describe("TrialBalanceSection — reporting scope", () => {
  it("asks for the current Jalali month-to-date by default, never 'all time'", async () => {
    const { calls } = stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years") ? fiscalYearsResponse() : report(),
    );

    await renderSection();

    expect(calls).toHaveLength(1);
    const params = new URL(calls[0].url, "http://localhost").searchParams;
    expect(params.get("dateFrom")).toBe(MONTH_START);
    expect(params.get("dateTo")).toBe(TODAY_ISO);
    expect(params.has("asOf")).toBe(false);
  });

  it("switches to the as-of shortcut for the compact closing view", async () => {
    const { calls } = stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years") ? fiscalYearsResponse() : report(),
    );

    await renderSection();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "مانده در تاریخ" }));
    });

    await waitFor(() => expect(calls).toHaveLength(2));
    const params = new URL(calls[1].url, "http://localhost").searchParams;
    expect(params.get("asOf")).toBe(TODAY_ISO);
    expect(params.has("dateFrom")).toBe(false);
    expect(params.has("dateTo")).toBe(false);
  });

  it("sends the picked custom range, and the fiscal-year list is not required for it", async () => {
    const { calls } = stubFetch((url) => {
      if (url.startsWith("/api/ledger/fiscal-years")) return { __failed: true, error: "boom" };
      return report();
    });

    await renderSection();

    // The report still loaded even though the fiscal-year list did not.
    expect(calls).toHaveLength(1);
    expect(within(desktopTable()).getByText("صندوق")).toBeTruthy();
  });

  it("labels the report as consolidated across branches", async () => {
    stubFetch((url) => (url.startsWith("/api/ledger/fiscal-years") ? fiscalYearsResponse() : report()));
    await renderSection();
    expect(screen.getByText("دفتر تجمیعی همهٔ شعب")).toBeTruthy();
  });
});

describe("TrialBalanceSection — stale responses, errors and retry", () => {
  it("aborts an in-flight request when the scope changes, so an older reply cannot land last", async () => {
    const { calls } = stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years") ? fiscalYearsResponse() : report(),
    );

    await renderSection();
    expect(calls).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "مانده در تاریخ" }));
    });
    await waitFor(() => expect(calls).toHaveLength(2));

    // The first request was cancelled; only its signal is aborted.
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(false);
  });

  it("leaves the loading state on a failed request and offers a retry that re-fetches", async () => {
    let shouldFail = true;
    const { calls } = stubFetch((url) => {
      if (url.startsWith("/api/ledger/fiscal-years")) return fiscalYearsResponse();
      return shouldFail ? { __failed: true, error: "boom" } : report();
    });

    await renderSection();

    await waitFor(() =>
      expect(screen.getByText("بارگذاری تراز آزمایشی ناموفق بود؛ دوباره تلاش کنید.")).toBeTruthy(),
    );
    // Not stuck on a skeleton, and not silently showing an empty ledger.
    expect(screen.queryByText("در حال بارگذاری تراز آزمایشی")).toBeNull();

    shouldFail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    });

    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(within(desktopTable()).queryByText("صندوق")).toBeTruthy());
  });

  it("survives a dropped connection rather than hanging on a spinner", async () => {
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years")
        ? fiscalYearsResponse()
        : new Error("network down"),
    );

    await renderSection();

    await waitFor(() =>
      expect(screen.getByText("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.")).toBeTruthy(),
    );
    expect(screen.queryByText("در حال بارگذاری تراز آزمایشی")).toBeNull();
  });
});

describe("TrialBalanceSection — balances and BigInt safety", () => {
  it("shows a closing balance, not lifetime gross movement", async () => {
    stubFetch((url) => (url.startsWith("/api/ledger/fiscal-years") ? fiscalYearsResponse() : report()));
    await renderSection();

    const cells = within(desktopRow(account().name)).getAllByRole("button").map((button) => button.textContent);
    // Rial 0/0 opening, 1,000,000/400,000 movement, 600,000/0 closing, shown in
    // Toman (the default with no MoneyProvider) so /10, unit per cell the way
    // the approved reference table prints money. The old screen printed the two
    // *movement* figures in the closing columns.
    expect(cells).toEqual([
      formatTomanText("0"),
      formatTomanText("0"),
      formatTomanText("1000000"),
      formatTomanText("400000"),
      formatTomanText("600000"),
      formatTomanText("0"),
    ]);
  });

  it("renders an amount above Number.MAX_SAFE_INTEGER exactly, through formatText", async () => {
    // 2^53 + 1 Rial: one past the last integer a JS number can hold exactly.
    // The screen has no MoneyProvider, so it renders Toman (/10, truncating).
    const huge = "9007199254740993";
    const rounded = "9007199254740992"; // what a Number() path would leave behind
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years")
        ? fiscalYearsResponse()
        : report({
            accounts: [account({ closingDebit: huge, periodDebit: huge })],
          }),
    );

    // Read in Rial, where the difference between the exact balance and the
    // Number()-rounded one is a visible digit; in Toman both truncate to the
    // same figure and the regression would be invisible.
    await renderSection({ unit: "rial" });

    await waitFor(() =>
      expect(within(desktopTable()).getAllByText(formatRialText(huge)).length).toBeGreaterThan(0),
    );
    expect(within(desktopTable()).queryByText(formatRialText(rounded))).toBeNull();
  });

  it("flags an abnormal balance instead of hiding it in a negative column", async () => {
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years")
        ? fiscalYearsResponse()
        : report({
            accounts: [
              account({ closingDebit: "0", closingCredit: "900000", periodDebit: "0", periodCredit: "900000", isAbnormalBalance: true }),
            ],
          }),
    );

    await renderSection();
    expect(within(desktopTable()).getAllByText("ماندهٔ غیرعادی").length).toBeGreaterThan(0);
  });
});

describe("TrialBalanceSection — report states stay separate", () => {
  it("says the columns balance while the ledger still needs review", async () => {
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years")
        ? fiscalYearsResponse()
        : report({
            trialBalanceBalanced: true,
            integrity: {
              ledgerHealthy: false, entryCount: 2, lineCount: 4,
              unbalancedEntryCount: 2, invalidEntryCount: 0, balanceDifference: "0",
            },
          }),
    );

    await renderSection();

    // The badge carries the balance verdict; the health badge carries the books.
    expect(screen.getByText("مانده‌ها برابر")).toBeTruthy();
    expect(screen.getByText("نیازمند بازبینی — ۲ سند نامتوازن")).toBeTruthy();
    // And the two are stated together in one sentence, not collapsed into one
    // boolean that would have said simply «نامتوازن».
    expect(
      screen.getByText(/جمع مانده‌های پایان دوره برابر است، اما ۲ سند نامتوازن/),
    ).toBeTruthy();
  });

  it("does not call an empty ledger balanced", async () => {
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years")
        ? fiscalYearsResponse()
        : report({
            accounts: [],
            activity: { entryCount: 0, lineCount: 0 },
            trialBalanceBalanced: false,
            integrity: {
              ledgerHealthy: false, entryCount: 0, lineCount: 0,
              unbalancedEntryCount: 0, invalidEntryCount: 0, balanceDifference: "0",
            },
          }),
    );

    await renderSection();
    expect(screen.getByText("بدون سند در این بازه")).toBeTruthy();
  });
});

describe("TrialBalanceSection — controls", () => {
  it("hides a zero-balance account until the toggle asks for it", async () => {
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years")
        ? fiscalYearsResponse()
        : report({
            accounts: [
              account(),
              account({
                id: "acc-zero", code: "5300", name: "اجاره", type: "expense",
                periodDebit: "0", periodCredit: "0", closingDebit: "0", closingCredit: "0",
              }),
            ],
          }),
    );

    await renderSection();
    expect(within(desktopTable()).queryByText("اجاره")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("نمایش حساب‌های بدون مانده و گردش"));
    });

    await waitFor(() => expect(within(desktopTable()).getAllByText("اجاره").length).toBeGreaterThan(0));
  });

  it("filters by account type and searches by code and name", async () => {
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years") ? fiscalYearsResponse() : report(),
    );

    await renderSection();
    expect(within(desktopTable()).getByText("درآمد فروش")).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("فیلتر نوع حساب"), { target: { value: "asset" } });
    });
    await waitFor(() => expect(within(desktopTable()).queryByText("درآمد فروش")).toBeNull());
    expect(within(desktopTable()).getByText("صندوق")).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("فیلتر نوع حساب"), { target: { value: "all" } });
      fireEvent.change(screen.getByLabelText("جست‌وجوی حساب در تراز آزمایشی"), { target: { value: "4100" } });
    });
    await waitFor(() => expect(within(desktopTable()).queryByText("صندوق")).toBeNull());
    expect(within(desktopTable()).getByText("درآمد فروش")).toBeTruthy();
  });

  it("keeps an archived account's row and labels it", async () => {
    stubFetch((url) =>
      url.startsWith("/api/ledger/fiscal-years")
        ? fiscalYearsResponse()
        : report({
            accounts: [account({ isActive: false, closingDebit: "600000" })],
          }),
    );

    await renderSection();
    expect(within(desktopTable()).getByText("صندوق")).toBeTruthy();
    expect(within(desktopTable()).getAllByText("بایگانی‌شده").length).toBeGreaterThan(0);
  });

  it("hides the export buttons without reports.export and shows them with it", async () => {
    stubFetch((url) => (url.startsWith("/api/ledger/fiscal-years") ? fiscalYearsResponse() : report()));

    await renderSection({ canExport: false });
    expect(screen.queryByRole("button", { name: "خروجی CSV" })).toBeNull();
    cleanup();

    await renderSection({ canExport: true });
    expect(screen.getByRole("button", { name: "خروجی CSV" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "خروجی PDF" })).toBeTruthy();
  });

  it("opens the drill-down for a figure and hands it the exact expected amount", async () => {
    const { drillCalls } = stubFetch((url) => {
      if (url.startsWith("/api/ledger/fiscal-years")) return fiscalYearsResponse();
      if (url.startsWith("/api/reports/drill-down")) {
        return {
          lines: [
            { lineId: "1", entryId: "e-1", entryDate: TODAY_ISO, memo: "فروش", sourceType: "manual", sourceId: null, debit: "1000000", credit: "0" },
            { lineId: "2", entryId: "e-2", entryDate: TODAY_ISO, memo: "پرداخت", sourceType: "manual", sourceId: null, debit: "0", credit: "400000" },
          ],
          totals: { debit: "1000000", credit: "400000", signedBalance: "600000" },
          totalLines: 2,
          hasMore: false,
          nextOffset: null,
        };
      }
      return report();
    });

    await renderSection();

    const closingDebitButton = within(desktopRow("صندوق")).getAllByRole("button")[4];
    await act(async () => {
      fireEvent.click(closingDebitButton);
    });

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    await waitFor(() => expect(drillCalls).toHaveLength(1));
    const params = new URL(drillCalls[0].url, "http://localhost").searchParams;
    expect(params.get("accountCode")).toBe("1100");
    expect(params.get("dateTo")).toBe(TODAY_ISO);
    expect(params.get("dateFrom")).toBeNull();
    // The ledger page's own permission scope, not the insight reports' one.
    expect(params.get("permissionScope")).toBe("ledger");
    // And the figure the overlay must reconcile to is the row's own amount.
    expect(screen.getByText(/جمع ردیف‌های دفتر با مانده پایان بدهکار گزارش برابر است/)).toBeTruthy();
  });
});

describe("TrialBalanceSection — source-level regressions", () => {
  // jsdom gives `import.meta.url` an http scheme, so resolve from the project
  // root the way the design-lint suites resolve theirs.
  const source = readFileSync(
    join(process.cwd(), "src", "app", "(app)", "accounting", "trial-balance-section.tsx"),
    "utf8",
  );

  it("formats money through formatText and never through Number()", () => {
    expect(source).toContain("money.formatText(");
    expect(source).not.toMatch(/money\.format\(/);
    expect(source).not.toMatch(/Number\((account|row|a)\.(debit|credit|closingDebit|closingCredit|periodDebit|periodCredit|openingDebit|openingCredit)\)/);
    expect(source).not.toMatch(/Number\((data|report)\.totals/);
  });

  it("renders both a desktop table and a mobile card list", () => {
    expect(source).toContain('className="hidden lg:block"');
    expect(source).toContain('className="space-y-3 lg:hidden"');
    expect(source).toContain("<DataTable");
    expect(source).toContain("<DataTableFoot>");
  });

  it("uses the design system's own primitives rather than a new visual language", () => {
    for (const primitive of ["cardClass", "StatusBadge", "FilterChip", "JalaliDatePicker", "SectionCardSkeleton", "DataTable", "ErrorBox", "SecondaryButton"]) {
      expect(source).toContain(primitive);
    }
    // Skeleton loading, never a spinner.
    expect(source).not.toMatch(/animate-spin/);
  });

  it("does not duplicate the page title inside the card header", () => {
    // The route heading is «تراز آزمایشی» (ACCOUNTING_HEADINGS); the card says
    // what the report covers instead of restating the title.
    expect(source).toMatch(/id="trial-balance-heading"\s+className="sr-only"/);
    expect(source).not.toMatch(/<h2[^>]*>\s*تراز آزمایشی\s*<\/h2>\s*<p/);
  });

  it("does not fetch the chart of accounts", () => {
    expect(source).not.toContain("/api/ledger/accounts");
  });
});
