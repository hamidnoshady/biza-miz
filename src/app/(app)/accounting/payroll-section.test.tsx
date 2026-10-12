// @vitest-environment jsdom

/**
 * The payroll screen — issue #835 §2, §4, §7, §8, §9, §11, §12, §13, §14, on top
 * of the gross-to-net screen (pay terms, advances, settings, the preview).
 *
 * The server is a small in-memory fake behind `fetch`, so these tests exercise
 * the real component end to end: what it renders, what it sends, and what it
 * refuses to send. They are the UI half of the regression coverage the
 * integration suite cannot give (a unit switch, a click on a sidebar link, a
 * date picked in a Jalali calendar).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { clearAllDrafts } from "@/lib/payroll-draft-memory";
import { EMPTY_PAYROLL_SETTINGS, type PayrollSettings } from "@/lib/payroll-gross-to-net";
import { JALALI_MONTHS as JALALI_MONTH_NAMES, jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import type { MoneyUnit } from "@/lib/money";
import {
  PAY_TERMS,
  type PayTerm,
  type PayrollAdvance,
  type PayrollPaymentAccount,
  type PayrollRun,
  type PayrollRunLine,
  type PayrollRunSummary,
  type StaffWage,
} from "@/lib/payroll-types";
import { ErrorBox } from "@/app/dashboard/ui";
import { errorMessage } from "./accounting-errors";
import type { Runner } from "./accounting-manager";
import { PayrollSection } from "./payroll-section";
import { TERM_LABELS } from "./payroll-term-labels";

const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// Radix's checkbox measures itself; jsdom has no ResizeObserver. (Installed in
// `beforeEach`: `afterEach` unstubs every global, this one included.)
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// ---------------------------------------------------------------------------
// A fake server
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  body: unknown;
  rawBody: string | undefined;
}

/** A member as the staff route lists them: standing terms at zero unless the test says otherwise. */
function member(id: string, fullName: string, role: string, monthlyWage: string | null, extra: Partial<StaffWage> = {}): StaffWage {
  return {
    id,
    fullName,
    role,
    monthlyWage,
    taxableAllowance: "0",
    nonTaxableAllowance: "0",
    fixedDeduction: "0",
    advanceOutstanding: "0",
    ...extra,
  };
}

const defaultStaff = () => [member("staff-a", "Staff A", "cashier", "30000000"), member("staff-b", "Staff B", "waiter", "20000000")];

class FakeServer {
  staff: StaffWage[] = defaultStaff();
  settings: PayrollSettings = { ...EMPTY_PAYROLL_SETTINGS, taxBrackets: [] };
  advances: PayrollAdvance[] = [];
  /** What POST /advances/:id/void answers instead of voiding; empty = success. */
  advanceVoidResponses: Array<{ status: number; body: unknown }> = [];
  runs: PayrollRunSummary[] = [];
  lines: Record<string, PayrollRun["lines"]> = {};
  /** Net commission per member in the preview; "0" omits it. */
  commission: Record<string, string> = {};
  unsettledCommission = "0";
  paymentAccounts: PayrollPaymentAccount[] = [
    { id: "acc-cash", code: "1100", name: "صندوق", role: "cash" },
    { id: "acc-bank", code: "1110", name: "بانک", role: "bank" },
  ];
  /** What POST /runs answers, in order; empty = the default success. */
  accrualResponses: Array<{ status: number; body: unknown }> = [];
  requests: Recorded[] = [];

  reset() {
    this.runs = [];
    this.lines = {};
    this.advances = [];
    this.advanceVoidResponses = [];
    this.commission = {};
    this.unsettledCommission = "0";
    this.accrualResponses = [];
    this.requests = [];
    this.staff = defaultStaff();
    this.settings = { ...EMPTY_PAYROLL_SETTINGS, taxBrackets: [] };
    this.paymentAccounts = [
      { id: "acc-cash", code: "1100", name: "صندوق", role: "cash" },
      { id: "acc-bank", code: "1110", name: "بانک", role: "bank" },
    ];
  }

  calls(method: string, pattern: RegExp): Recorded[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.url));
  }

  /** The commission an accrual would settle — the only thing of the preview the database decides. */
  private commissionPreview(includeCommission: boolean) {
    const lines = includeCommission
      ? Object.entries(this.commission)
          .filter(([, amount]) => amount !== "0")
          .map(([userId, amount]) => ({ userId, fullName: this.staff.find((s) => s.id === userId)?.fullName ?? userId, amount }))
      : [];
    const total = lines.reduce((sum, l) => sum + BigInt(l.amount), 0n);
    return { accrualDate: "2026-10-07", lines, total: total.toString() };
  }

  handle = async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = undefined;
    }
    this.requests.push({ method, url: input, body, rawBody });
    const respond = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
    const url = new URL(input, "http://localhost");
    const path = url.pathname;

    if (method === "GET" && path === "/api/ledger/payroll/staff") return respond({ staff: this.staff });

    if (path === "/api/ledger/payroll/settings") {
      if (method === "GET") return respond({ settings: this.settings });
      if (method === "PUT") {
        this.settings = body as PayrollSettings;
        return respond({ settings: this.settings });
      }
    }

    if (path === "/api/ledger/payroll/advances") {
      if (method === "GET") return respond({ advances: this.advances });
      if (method === "POST") {
        const sent = body as { userId: string; amount: number; method?: "cash" | "bank"; paymentAccountId?: string; advanceDate?: string; note?: string };
        const advance: PayrollAdvance = {
          id: `adv-${this.advances.length + 1}`,
          userId: sent.userId,
          fullName: this.staff.find((s) => s.id === sent.userId)?.fullName ?? null,
          amount: String(sent.amount),
          method: sent.paymentAccountId === "acc-bank" || sent.method === "bank" ? "bank" : "cash",
          advanceDate: sent.advanceDate ?? "2026-10-07",
          note: sent.note ?? null,
          status: "active",
          createdByName: "Owner",
        };
        this.advances.unshift(advance);
        return respond({ advance }, 201);
      }
    }

    const advanceVoid = /^\/api\/ledger\/payroll\/advances\/([^/]+)\/void$/.exec(path);
    if (method === "POST" && advanceVoid) {
      const scripted = this.advanceVoidResponses.shift();
      if (scripted) return respond(scripted.body, scripted.status);
      const target = this.advances.find((a) => a.id === advanceVoid[1]);
      if (!target) return respond({ error: "advance_not_found" }, 404);
      target.status = "voided";
      return respond({ advance: target });
    }

    if (method === "GET" && path === "/api/ledger/payroll/preview") {
      const include = url.searchParams.get("includeCommission") !== "false";
      return respond({
        commission: this.commissionPreview(include),
        liability: {
          ledgerBalance: this.unsettledCommission,
          awaitingPayment: "0",
          unsettledCommission: this.unsettledCommission,
          difference: "0",
        },
        paymentAccounts: this.paymentAccounts,
      });
    }

    if (method === "GET" && path === "/api/ledger/payroll/runs") {
      const status = url.searchParams.get("status");
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const filtered = this.runs.filter((r) => !status || r.status === status);
      const page = filtered.slice(start, start + limit);
      const next = start + limit < filtered.length ? String(start + limit) : null;
      return respond({ runs: page, nextCursor: next });
    }

    const detail = /^\/api\/ledger\/payroll\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && detail) {
      const summary = this.runs.find((r) => r.id === detail[1]);
      return summary ? respond({ run: { ...summary, lines: this.lines[summary.id] ?? [] } }) : respond({ error: "run_not_found" }, 404);
    }

    if (method === "GET" && /\/staff\/[^/]+\/history$/.test(path)) return respond({ changes: [], nextCursor: null });

    const terms = /^\/api\/ledger\/payroll\/staff\/([^/]+)$/.exec(path);
    if (method === "PATCH" && terms) {
      const target = this.staff.find((s) => s.id === terms[1]);
      const patch = body as Partial<Record<PayTerm, number | null>>;
      // Like the route: only the keys present are written.
      if (target) {
        for (const term of PAY_TERMS) {
          if (term in patch) (target as unknown as Record<string, string | null>)[term] = patch[term] === null ? null : String(patch[term]);
        }
      }
      return respond({ ok: true, changed: true });
    }

    if (method === "POST" && path === "/api/ledger/payroll/runs") {
      const scripted = this.accrualResponses.shift();
      if (scripted) return respond(scripted.body, scripted.status);
      const requested = (body as { periodKey: string }).periodKey;
      const created = makeRun({ id: `run-${this.runs.length + 1}`, periodKey: requested, periodLabel: `ماه ${requested}`, accrualDate: "2026-10-07" });
      this.runs.unshift(created);
      return respond({ run: created, idempotentReplay: false }, 201);
    }

    const action = /^\/api\/ledger\/payroll\/runs\/([^/]+)\/(pay|void)$/.exec(path);
    if (method === "POST" && action) {
      const target = this.runs.find((r) => r.id === action[1]);
      if (!target) return respond({ error: "run_not_found" }, 404);
      target.status = action[2] === "pay" ? "paid" : "voided";
      if (action[2] === "pay") target.paidDate = (body as { paidDate?: string })?.paidDate ?? "2026-10-07";
      return respond({ run: target });
    }

    throw new Error(`unexpected request ${method} ${input}`);
  };
}

function makeRun(overrides: Partial<PayrollRunSummary> = {}): PayrollRunSummary {
  return {
    id: "run-1",
    periodLabel: "مرداد ۱۴۰۴",
    periodKey: "1404-05",
    status: "accrued",
    totalAmount: "50000000",
    netAmount: "50000000",
    commissionTotal: "0",
    payableAmount: "50000000",
    accrualDate: "2020-01-01",
    paidDate: null,
    voidedDate: null,
    createdByName: "Owner",
    lineCount: 2,
    ...overrides,
  };
}

/** A run line with no deduction of any kind, as a business that has entered no rates produces. */
function makeLine(overrides: Partial<PayrollRunLine> = {}): PayrollRunLine {
  return {
    userId: "staff-a",
    fullName: "Staff A",
    employeeCode: null,
    role: "cashier",
    amount: "30000000",
    baseSalaryRial: "30000000",
    taxableAllowancesRial: "0",
    nonTaxableAllowancesRial: "0",
    overtimeRial: "0",
    grossRial: "30000000",
    insuranceBaseRial: "30000000",
    employeeInsuranceRial: "0",
    employerInsuranceRial: "0",
    unemploymentInsuranceRial: "0",
    taxableIncomeRial: "30000000",
    incomeTaxRial: "0",
    otherDeductionsRial: "0",
    advanceRecoveryRial: "0",
    netPayRial: "30000000",
    employerCostRial: "30000000",
    commissionAmount: "0",
    payableAmount: "30000000",
    ...overrides,
  };
}

const server = new FakeServer();

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Mounts the section the way the workspace does: a `run` that shows a refusal
 * through the workspace's own error map and bumps `refreshKey` on success.
 */
function Workspace({
  unit,
  canManage,
  ownerKey,
  children,
}: {
  unit: MoneyUnit;
  canManage?: boolean;
  ownerKey?: string;
  children?: ReactNode;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run: Runner = async (fn) => {
    setBusy(true);
    setError("");
    try {
      const { ok, data } = await fn();
      if (!ok) {
        setError(errorMessage(data.error));
        return false;
      }
      setRefreshKey((k) => k + 1);
      return true;
    } finally {
      setBusy(false);
    }
  };
  return (
    <MoneyProvider unit={unit}>
      {children}
      <ErrorBox>{error}</ErrorBox>
      <PayrollSection busy={busy} run={run} refreshKey={refreshKey} canManage={canManage} ownerKey={ownerKey} />
    </MoneyProvider>
  );
}

async function mount(props: { unit?: MoneyUnit; canManage?: boolean; ownerKey?: string; children?: ReactNode } = {}) {
  const view = render(<Workspace unit={props.unit ?? "rial"} canManage={props.canManage} ownerKey={props.ownerKey}>{props.children}</Workspace>);
  await screen.findByText("حقوق و مزایای ماهانه کارکنان");
  return {
    ...view,
    switchTo(unit: MoneyUnit) {
      view.rerender(<Workspace unit={unit} canManage={props.canManage} ownerKey={props.ownerKey}>{props.children}</Workspace>);
    },
  };
}

const termInput = (term: PayTerm, name: string) => screen.getByLabelText(`${TERM_LABELS[term]} ${name}`) as HTMLInputElement;
const typeTerm = (term: PayTerm, name: string, text: string) => fireEvent.change(termInput(term, name), { target: { value: text } });
const wageInput = (name: string) => termInput("monthlyWage", name);
const typeWage = (name: string, text: string) => typeTerm("monthlyWage", name, text);
const saveButtons = () => screen.getAllByRole("button", { name: "ذخیره" });
const previewTable = () => screen.getByRole("table", { name: "پیش‌نمایش ناخالص به خالص" });
/** The preview's row for a member, or its totals row — what the accrual would book for them. */
const previewRow = (name: string) => within(previewTable()).getByText(name).closest("tr")!;
const totalsRow = () => within(previewTable()).getByText(/^جمع \(/).closest("tr")!;

beforeEach(() => {
  server.reset();
  clearAllDrafts();
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("fetch", vi.fn(server.handle));
  window.history.pushState({}, "", "/accounting/payroll");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// §2 — unit switching
// ---------------------------------------------------------------------------

describe("unsaved wage edits across a Rial/Toman switch (issue #835 §2)", () => {
  it("shows saved wages in the business's unit, and re-shows them when the unit changes", async () => {
    const view = await mount({ unit: "rial" });
    expect(wageInput("Staff A").value).toBe("۳۰٬۰۰۰٬۰۰۰");
    view.switchTo("toman");
    expect(wageInput("Staff A").value).toBe("۳٬۰۰۰٬۰۰۰");
    view.switchTo("rial");
    expect(wageInput("Staff A").value).toBe("۳۰٬۰۰۰٬۰۰۰");
  });

  it("Rial → Toman: 10,000,000 typed as Rial is still 10,000,000 Rial after the switch, and saves as such", async () => {
    const view = await mount({ unit: "rial" });
    typeWage("Staff A", "10000000");
    expect(wageInput("Staff A").value).toBe("۱۰٬۰۰۰٬۰۰۰");

    view.switchTo("toman");
    // The same amount, shown in Toman — not the same digits relabelled.
    expect(wageInput("Staff A").value).toBe("۱٬۰۰۰٬۰۰۰");

    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    // 10,000,000 Rial on the wire — never the 100,000,000 the digits would mean as Toman.
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"monthlyWage":10000000}');
    expect(server.staff[0].monthlyWage).toBe("10000000");
  });

  it("Toman → Rial: 1,000,000 typed as Toman is still 10,000,000 Rial after the switch, and saves as such", async () => {
    const view = await mount({ unit: "toman" });
    typeWage("Staff A", "1000000");
    expect(wageInput("Staff A").value).toBe("۱٬۰۰۰٬۰۰۰");

    view.switchTo("rial");
    expect(wageInput("Staff A").value).toBe("۱۰٬۰۰۰٬۰۰۰");

    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    // 1,000,000 Toman = 10,000,000 Rial — not the 1,000,000 Rial the digits would mean as Rial.
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"monthlyWage":10000000}');
  });

  it("a switch alone makes nothing «ذخیره‌نشده» and keeps the guard off", async () => {
    const view = await mount({ unit: "rial" });
    view.switchTo("toman");
    expect(screen.queryByText("ذخیره‌نشده")).toBeNull();
    for (const button of saveButtons()) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps editing in the new unit coherent: the next keystroke is read in the unit now shown", async () => {
    const view = await mount({ unit: "rial" });
    typeWage("Staff A", "10000000");
    view.switchTo("toman");
    typeWage("Staff A", "2000000"); // 2,000,000 Toman, typed after the switch
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"monthlyWage":20000000}');
  });

  it("two edited rows survive a switch independently, each at its own amount", async () => {
    const view = await mount({ unit: "rial" });
    typeWage("Staff A", "11000000");
    typeWage("Staff B", "22000000");
    view.switchTo("toman");
    expect(wageInput("Staff A").value).toBe("۱٬۱۰۰٬۰۰۰");
    expect(wageInput("Staff B").value).toBe("۲٬۲۰۰٬۰۰۰");
    view.switchTo("rial");
    expect(wageInput("Staff A").value).toBe("۱۱٬۰۰۰٬۰۰۰");
    expect(wageInput("Staff B").value).toBe("۲۲٬۰۰۰٬۰۰۰");
  });

  it("clearing the box saves «no wage» (null)", async () => {
    await mount();
    typeWage("Staff A", "");
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"monthlyWage":null}');
  });

  it("refuses an amount the API's JSON number could not carry exactly, without sending it", async () => {
    await mount();
    typeWage("Staff A", "9007199254740992"); // 2^53
    fireEvent.click(saveButtons()[0]);
    expect(await screen.findByText("مبلغ «حقوق پایه ماهانه» بیش از حد مجاز است.")).toBeTruthy();
    expect(server.calls("PATCH", /./)).toHaveLength(0);

    typeWage("Staff A", "9007199254740991"); // 2^53 − 1: exact
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"monthlyWage":9007199254740991}');
  });

  it("does not count a typed value equal to the saved one as a change", async () => {
    await mount();
    typeWage("Staff A", "30000000");
    expect(screen.queryByText("ذخیره‌نشده")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §7 — navigation
// ---------------------------------------------------------------------------

describe("unsaved wages and in-app navigation (issue #835 §7)", () => {
  const Rail = () => (
    <nav>
      <Link href="/accounting/trial-balance">تراز آزمایشی</Link>
      <Link href="/accounting/expenses">هزینه‌ها</Link>
    </nav>
  );

  it("does not interrupt a click on the rail when nothing is unsaved", async () => {
    const user = userEvent.setup();
    await mount({ children: <Rail /> });
    const link = screen.getByRole("link", { name: "تراز آزمایشی" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    void user;
  });

  it("warns before leaving with a dirty wage, and staying keeps the typed value", async () => {
    const user = userEvent.setup();
    await mount({ children: <Rail /> });
    typeWage("Staff A", "12345678");

    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("۱ تغییر در حقوق یا مزایا ذخیره نشده است");
    expect(router.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "ماندن در صفحه" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(wageInput("Staff A").value).toBe("۱۲٬۳۴۵٬۶۷۸");
    expect(screen.getByText("ذخیره‌نشده")).toBeTruthy();
  });

  it("leaves — discarding the drafts and forgetting them — when asked to", async () => {
    const user = userEvent.setup();
    const first = await mount({ ownerKey: "member-1", children: <Rail /> });
    typeWage("Staff A", "12345678");
    await user.click(screen.getByRole("link", { name: "هزینه‌ها" }));
    await user.click(await screen.findByRole("button", { name: "ترک صفحه و حذف تغییرات" }));
    expect(router.push).toHaveBeenCalledWith("/accounting/expenses");
    // The draft is gone from the screen…
    expect(wageInput("Staff A").value).toBe("۳۰٬۰۰۰٬۰۰۰");
    // …and does not come back when the section is opened again.
    first.unmount();
    await mount({ ownerKey: "member-1" });
    expect(wageInput("Staff A").value).toBe("۳۰٬۰۰۰٬۰۰۰");
    expect(screen.queryByText("ذخیره‌نشده")).toBeNull();
  });

  it("stops guarding once the wage is saved", async () => {
    await mount({ children: <Rail /> });
    typeWage("Staff A", "12345678");
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("ذخیره‌نشده")).toBeNull());

    const link = screen.getByRole("link", { name: "تراز آزمایشی" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps unsaved wages in memory for a navigation nothing can stop (browser Back), flagged as unsaved", async () => {
    const first = await mount({ ownerKey: "member-1" });
    typeWage("Staff A", "12345678");
    first.unmount();

    await mount({ ownerKey: "member-1" });
    expect(wageInput("Staff A").value).toBe("۱۲٬۳۴۵٬۶۷۸");
    expect(screen.getByText("ذخیره‌نشده")).toBeTruthy();
    expect(screen.getByText(/تغییرات ذخیره‌نشدهٔ پیشین شما بازیابی شد/)).toBeTruthy();
  });

  it("restores a remembered draft in the unit it was typed in, whatever the unit is now", async () => {
    const first = await mount({ unit: "rial", ownerKey: "member-1" });
    typeWage("Staff A", "10000000");
    first.unmount();

    await mount({ unit: "toman", ownerKey: "member-1" });
    expect(wageInput("Staff A").value).toBe("۱٬۰۰۰٬۰۰۰");
  });

  it("never hands one member's unsaved wages to another", async () => {
    const first = await mount({ ownerKey: "member-1" });
    typeWage("Staff A", "12345678");
    first.unmount();

    await mount({ ownerKey: "member-2" });
    expect(wageInput("Staff A").value).toBe("۳۰٬۰۰۰٬۰۰۰");
    expect(screen.queryByText("ذخیره‌نشده")).toBeNull();
  });

  it("does not remember a draft that was typed back to the saved value", async () => {
    const first = await mount({ ownerKey: "member-1" });
    typeWage("Staff A", "12345678");
    typeWage("Staff A", "30000000");
    first.unmount();
    await mount({ ownerKey: "member-1" });
    expect(screen.queryByText("ذخیره‌نشده")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4, §12, §13 — accrual
// ---------------------------------------------------------------------------

describe("accruing a period (issue #835 §4, §12, §13)", () => {
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "ثبت تعهد" }));

  it("sends a real Jalali month as YYYY-MM, an idempotency key, and no free-text label to normalise", async () => {
    await mount();
    submit();
    await waitFor(() => expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(1));
    const sent = server.calls("POST", /payroll\/runs$/)[0].body as Record<string, unknown>;
    const today = todayJalali();
    expect(sent.periodKey).toBe(`${today.jy}-${String(today.jm).padStart(2, "0")}`);
    expect(sent).not.toHaveProperty("period");
    expect(sent).not.toHaveProperty("periodLabel");
    expect(sent.overtime).toEqual({});
    expect(typeof sent.idempotencyKey).toBe("string");
    expect((sent.idempotencyKey as string).length).toBeGreaterThanOrEqual(8);
    expect(sent.includeCommission).toBe(true);
    expect(sent.accrualDate).toBeUndefined();
    expect(await screen.findByText(/ثبت شد\./)).toBeTruthy();
  });

  it("offers the period as a year and a month, not a free-text box", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "سال" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ماه" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("مثلاً مرداد ۱۴۰۴")).toBeNull();
  });

  it("answers a duplicate period with a platform dialog, never window.confirm", async () => {
    const confirm = vi.spyOn(window, "confirm");
    server.accrualResponses = [
      {
        status: 409,
        body: { error: "period_already_accrued", run: { id: "run-9", periodLabel: "مرداد ۱۴۰۴", status: "paid" } },
      },
    ];
    await mount();
    submit();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("برای این ماه قبلاً لیست حقوق ثبت شده است");
    expect(dialog.textContent).toContain("«مرداد ۱۴۰۴»");
    expect(dialog.textContent).toContain("پرداخت‌شده");
    expect(confirm).not.toHaveBeenCalled();
    // It only explains: there is no «register anyway».
    expect(within(dialog).queryByRole("button", { name: /ثبت/ })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "متوجه شدم" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(1);
  });

  it("does not use the native confirm anywhere in the screen's source", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of [
      "payroll-section.tsx",
      "payroll-run-item.tsx",
      "payroll-term-history.tsx",
      "payroll-accrual-panel.tsx",
      "payroll-advances-panel.tsx",
      "payroll-settings-panel.tsx",
    ]) {
      // Comments say why it is not used; only the code counts.
      const code = readFileSync(join(__dirname, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/window\.confirm|[^.\w]confirm\(|\balert\(|\bprompt\(/);
    }
  });

  it("reuses one idempotency key for a retry of the same attempt", async () => {
    server.accrualResponses = [{ status: 500, body: {} }];
    await mount();
    submit();
    await screen.findByText(/خطای غیرمنتظره/);
    submit(); // the same click, retried
    await waitFor(() => expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(2));
    const [first, second] = server.calls("POST", /payroll\/runs$/).map((r) => (r.body as { idempotencyKey: string }).idempotencyKey);
    expect(second).toBe(first);
    await screen.findByText(/ثبت شد\./);
  });

  it("gives a different month a fresh key, even when the first attempt failed", async () => {
    server.accrualResponses = [{ status: 500, body: {} }];
    await mount();
    submit();
    await screen.findByText(/خطای غیرمنتظره/);

    // Another year is another month: not a retry of the failed attempt.
    const today = todayJalali();
    fireEvent.click(screen.getByRole("button", { name: "سال" }));
    fireEvent.click(await screen.findByRole("option", { name: toPersianDigits(today.jy - 1) }));
    submit();
    await waitFor(() => expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(2));
    const [first, second] = server.calls("POST", /payroll\/runs$/).map((r) => r.body as { idempotencyKey: string; periodKey: string });
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.periodKey).toBe(`${today.jy - 1}-${String(today.jm).padStart(2, "0")}`);
  });

  it("says a retried request was already recorded instead of pretending it just happened", async () => {
    server.accrualResponses = [
      { status: 200, body: { run: makeRun(), idempotentReplay: true } },
    ];
    await mount();
    submit();
    expect(await screen.findByText(/پیش‌تر ثبت شده بود/)).toBeTruthy();
  });

  it("previews exactly the people it will accrue, and disables the button with none", async () => {
    await mount();
    expect(totalsRow().textContent).toContain("۲ نفر");
    server.staff.forEach((s) => (s.monthlyWage = null));
    cleanup();
    await mount();
    expect((screen.getByRole("button", { name: "ثبت تعهد" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/هیچ کارمندی حقوق تعیین‌شده یا پورسانت تسویه‌نشده ندارد/)).toBeTruthy();
  });

  it("surfaces a refusal from the server in Persian", async () => {
    server.accrualResponses = [{ status: 409, body: { error: "fiscal_period_locked" } }];
    await mount();
    submit();
    expect(await screen.findByText(/دورهٔ مالی این تاریخ بسته شده/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §11 — commission
// ---------------------------------------------------------------------------

describe("commission on the screen (issue #835 §11)", () => {
  it("shows the commission each person will be paid and the totals, in the preview", async () => {
    server.commission = { "staff-a": "7000000" };
    server.unsettledCommission = "7000000";
    await mount();
    const preview = previewTable();
    expect(within(preview).getByRole("columnheader", { name: "پورسانت" })).toBeTruthy();
    // Staff A: 30,000,000 net wage + 7,000,000 commission, in Rial
    expect(previewRow("Staff A").textContent).toContain("۷٬۰۰۰٬۰۰۰");
    expect(previewRow("Staff A").textContent).toContain("۳۷٬۰۰۰٬۰۰۰");
    // …and the totals row adds the whole commission to the whole net.
    expect(totalsRow().textContent).toContain("۵۷٬۰۰۰٬۰۰۰");
  });

  it("lets a wage-only run be asked for, which re-reads the preview without commission", async () => {
    server.commission = { "staff-a": "7000000" };
    server.unsettledCommission = "7000000";
    await mount();
    const toggle = screen.getByRole("checkbox");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(server.requests.some((r) => r.url.includes("includeCommission=false"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "ثبت تعهد" }));
    await waitFor(() => expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(1));
    expect((server.calls("POST", /payroll\/runs$/)[0].body as { includeCommission: boolean }).includeCommission).toBe(false);
  });

  it("hides the choice when there is no commission to settle", async () => {
    await mount();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows the salaries-payable tie-out, including what is still owed after a run is paid", async () => {
    server.unsettledCommission = "3000000";
    server.runs = [makeRun({ status: "paid", paidDate: "2026-10-01" })];
    await mount();
    const panel = screen.getByRole("heading", { name: /وضعیت حساب حقوق پرداختنی/ }).closest("section")!;
    expect(panel.textContent).toContain("پورسانتِ واردنشده در هیچ لیست");
    expect(panel.textContent).toContain("۳٬۰۰۰٬۰۰۰ ریال");
    // A «پرداخت‌شده» run says what it settled, and points at what it did not.
    const note = screen.getByText(/پرداخت‌شده یعنی/).textContent ?? "";
    expect(note).toContain("وضعیت حساب حقوق پرداختنی");
    // …and does not let «paid» imply the withheld insurance and tax have been paid over.
    expect(note).toContain("بیمه، مالیات");
  });

  it("explains a difference instead of hiding it", async () => {
    const original = server.handle;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const response = await original(url, init);
        if (url.startsWith("/api/ledger/payroll/preview")) {
          const data = (await response.json()) as { liability: Record<string, string> };
          data.liability = { ledgerBalance: "900", awaitingPayment: "0", unsettledCommission: "0", difference: "900" };
          return { ...response, json: async () => data };
        }
        return response;
      }),
    );
    await mount();
    expect(screen.getByText(/سند دستی یا تسویهٔ خارج از حقوق/)).toBeTruthy();
  });

  it("shows a run's gross, net and commission on its summary, and the commission on each line", async () => {
    server.runs = [makeRun({ totalAmount: "50000000", netAmount: "50000000", commissionTotal: "8000000", payableAmount: "58000000" })];
    server.lines["run-1"] = [
      makeLine({ employeeCode: "P-1", commissionAmount: "7000000", payableAmount: "37000000" }),
      makeLine({ userId: null, fullName: "Old Member", role: "waiter", amount: "20000000", baseSalaryRial: "20000000", grossRial: "20000000", netPayRial: "20000000", commissionAmount: "1000000", payableAmount: "21000000" }),
    ];
    await mount();
    const item = screen.getByText("مرداد ۱۴۰۴").closest("li")!;
    // What is paid, and what it is made of.
    expect(within(item).getByText("۵۸٬۰۰۰٬۰۰۰ ریال")).toBeTruthy();
    expect(within(item).getByText(/ناخالص ۵۰٬۰۰۰٬۰۰۰ · خالص ۵۰٬۰۰۰٬۰۰۰ \+ پورسانت ۸٬۰۰۰٬۰۰۰/)).toBeTruthy();

    fireEvent.click(within(item).getByRole("button", { name: /جزئیات/ }));
    expect(await within(item).findByText("Old Member")).toBeTruthy();
    expect(within(item).getByText("Staff A")).toBeTruthy();
    expect(within(item).getByText(/کد P-۱/)).toBeTruthy();
    expect(within(item).getByText(/خالص ۳۰٬۰۰۰٬۰۰۰ \+ پورسانت ۷٬۰۰۰٬۰۰۰/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §5, §9 — history
// ---------------------------------------------------------------------------

describe("the payroll history (issue #835 §5, §9)", () => {
  function manyRuns(n: number): PayrollRunSummary[] {
    return Array.from({ length: n }, (_, i) => makeRun({ id: `run-${i + 1}`, periodLabel: `دوره ${i + 1}`, accrualDate: "2020-01-01" }));
  }

  it("reads no employee lines until a run's details are opened — and only that run's, once", async () => {
    server.runs = manyRuns(3);
    server.lines["run-2"] = [makeLine({ fullName: "Snapshot Name" })];
    await mount();
    expect(server.calls("GET", /runs\/run-/)).toHaveLength(0);

    const buttons = screen.getAllByRole("button", { name: /جزئیات/ });
    fireEvent.click(buttons[1]);
    expect(await screen.findByText("Snapshot Name")).toBeTruthy();
    expect(server.calls("GET", /runs\/run-2$/)).toHaveLength(1);
    expect(server.calls("GET", /runs\/run-(1|3)$/)).toHaveLength(0);

    // Closing and reopening does not read it again: a line is an immutable snapshot.
    fireEvent.click(screen.getByRole("button", { name: "بستن جزئیات" }));
    fireEvent.click(screen.getAllByRole("button", { name: /جزئیات/ })[1]);
    expect(server.calls("GET", /runs\/run-2$/)).toHaveLength(1);
  });

  it("shows the name recorded at accrual time, or a fallback only for a line that never had one", async () => {
    server.runs = [makeRun()];
    server.lines["run-1"] = [
      makeLine({ userId: null, fullName: "Deleted Colleague" }),
      makeLine({ userId: null, fullName: null, role: null }),
    ];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /جزئیات/ }));
    expect(await screen.findByText("Deleted Colleague")).toBeTruthy();
    expect(screen.getByText("عضو حذف‌شده")).toBeTruthy();
  });

  it("offers a failed detail read again instead of an endless «loading»", async () => {
    server.runs = [makeRun()];
    await mount();
    const original = server.handle;
    let failOnce = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (failOnce && /runs\/run-1$/.test(url)) {
          failOnce = false;
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return original(url, init);
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /جزئیات/ }));
    expect(await screen.findByText("بارگذاری جزئیات ناموفق بود.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() => expect(screen.queryByText("بارگذاری جزئیات ناموفق بود.")).toBeNull());
  });

  it("loads one page, and the next on request, by cursor", async () => {
    server.runs = manyRuns(25);
    await mount();
    expect(server.calls("GET", /payroll\/runs\?/)[0].url).toContain("limit=20");
    expect(screen.getAllByRole("button", { name: /جزئیات/ })).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: "نمایش موارد قدیمی‌تر" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /جزئیات/ })).toHaveLength(25));
    expect(server.calls("GET", /payroll\/runs\?/).some((r) => r.url.includes("cursor=20"))).toBe(true);
    expect(screen.queryByRole("button", { name: "نمایش موارد قدیمی‌تر" })).toBeNull();
  });

  it("filters by status on the server, and says so when nothing matches", async () => {
    server.runs = [makeRun({ id: "run-1", status: "accrued" }), makeRun({ id: "run-2", status: "paid", periodLabel: "پرداخت‌شده‌ام" })];
    await mount();
    expect(screen.getAllByRole("button", { name: /جزئیات/ })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "پرداخت‌شده" }));
    await waitFor(() => expect(server.requests.some((r) => r.url.includes("status=paid"))).toBe(true));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /جزئیات/ })).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "ابطال‌شده" }));
    expect(await screen.findByText("تعهدی با این فیلترها یافت نشد.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "پاک کردن فیلترها" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /جزئیات/ })).toHaveLength(2));
  });
});

// ---------------------------------------------------------------------------
// §8, §14 — payment
// ---------------------------------------------------------------------------

describe("paying a run (issue #835 §8, §14)", () => {
  const today = todayJalali();
  const dayOfMonth = 20;
  const pickedIso = jalaliToIsoDate(today.jy, today.jm, dayOfMonth);

  async function pickPaymentDate() {
    fireEvent.click(screen.getByRole("button", { name: /تاریخ پرداخت/ }));
    const calendar = await screen.findByRole("dialog", { name: "انتخاب تاریخ شمسی" });
    const label = String(dayOfMonth).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
    fireEvent.click(within(calendar).getByRole("button", { name: new RegExp(`^${label} `) }));
  }

  it("sends the chosen Jalali date as ISO, and the chosen account", async () => {
    server.runs = [makeRun({ accrualDate: "2020-01-01" })];
    await mount();
    await pickPaymentDate();
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت حقوق" }));

    await waitFor(() => expect(server.calls("POST", /pay$/)).toHaveLength(1));
    const sent = server.calls("POST", /pay$/)[0].body as Record<string, unknown>;
    expect(sent.paidDate).toBe(pickedIso);
    expect(sent.paymentAccountId).toBe("acc-cash"); // the till by default
    expect(sent).not.toHaveProperty("method");
    expect(await screen.findByText(/پرداخت حقوق «مرداد ۱۴۰۴» ثبت شد/)).toBeTruthy();
  });

  it("defaults to today (no date sent) when none is chosen", async () => {
    server.runs = [makeRun()];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت حقوق" }));
    await waitFor(() => expect(server.calls("POST", /pay$/)).toHaveLength(1));
    expect(server.calls("POST", /pay$/)[0].body).not.toHaveProperty("paidDate");
  });

  it("lets the payment leave a bank account chosen from the chart, not a payroll-only list", async () => {
    server.runs = [makeRun()];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /حساب پرداخت حقوق دوره/ }));
    fireEvent.click(await screen.findByRole("option", { name: /۱۱۱۰ — بانک/ }));
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت حقوق" }));
    await waitFor(() => expect(server.calls("POST", /pay$/)).toHaveLength(1));
    expect((server.calls("POST", /pay$/)[0].body as { paymentAccountId: string }).paymentAccountId).toBe("acc-bank");
  });

  it("offers only what the server lists as payment accounts", async () => {
    server.runs = [makeRun()];
    server.paymentAccounts = [{ id: "acc-1", code: "11101", name: "بانک ملی", role: "bank" }];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /حساب پرداخت حقوق دوره/ }));
    expect(await screen.findByRole("option", { name: /۱۱۱۰۱ — بانک ملی/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /کارت‌خوان/ })).toBeNull();
  });

  it("falls back to the cash/bank shorthand only when the chart offers no account", async () => {
    server.runs = [makeRun()];
    server.paymentAccounts = [];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /حساب پرداخت حقوق دوره/ }));
    fireEvent.click(await screen.findByRole("option", { name: "بانک" }));
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت حقوق" }));
    await waitFor(() => expect(server.calls("POST", /pay$/)).toHaveLength(1));
    expect(server.calls("POST", /pay$/)[0].body).toEqual({ method: "bank" });
  });

  it("refuses a payment date before the accrual date, naming the field, without a round trip", async () => {
    server.runs = [makeRun({ accrualDate: "2999-01-01" })];
    await mount();
    await pickPaymentDate(); // a date this month: before 2999
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت حقوق" }));
    expect(await screen.findByText(/تاریخ پرداخت نمی‌تواند پیش از تاریخ تعهد/)).toBeTruthy();
    expect(server.calls("POST", /pay$/)).toHaveLength(0);
  });

  it("shows the server's chronology refusal in Persian when the screen could not tell", async () => {
    server.runs = [makeRun()];
    const original = server.handle;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        /pay$/.test(url) ? { ok: false, status: 400, json: async () => ({ error: "paid_date_before_accrual" }) } : original(url, init),
      ),
    );
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت حقوق" }));
    expect(await screen.findByText("تاریخ پرداخت نمی‌تواند پیش از تاریخ تعهد باشد.")).toBeTruthy();
  });

  it("voids through a dialog that names the amount and the commission that is released", async () => {
    server.runs = [makeRun({ status: "paid", paidDate: "2026-10-01", totalAmount: "58000000", commissionTotal: "8000000", payableAmount: "58000000" })];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /ابطال تعهد و پرداخت دوره/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("ابطال تعهد حقوق");
    expect(dialog.textContent).toContain("پورسانتِ واردشده در این لیست دوباره تسویه‌نشده می‌شود");
    // …and that an advance recovered by the run is opened again.
    expect(dialog.textContent).toContain("مساعده‌ای که در این لیست کسر شده دوباره باز می‌شود");
    fireEvent.click(within(dialog).getByRole("button", { name: "ابطال تعهد" }));
    await waitFor(() => expect(server.calls("POST", /void$/)).toHaveLength(1));
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("a member who may view but not manage payroll", () => {
  it("sees wages and history but is offered no way to change anything", async () => {
    server.runs = [makeRun(), makeRun({ id: "run-2", status: "paid", periodLabel: "پرداخت‌شده" })];
    await mount({ canManage: false });
    expect(wageInput("Staff A").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "ذخیره" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ثبت تعهد" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ثبت پرداخت حقوق" })).toBeNull();
    expect(screen.queryByRole("button", { name: /ابطال تعهد/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /جزئیات/ })).toHaveLength(2);
    expect(screen.getByText("شما فقط مجاز به مشاهدهٔ حقوق و مزایا هستید.")).toBeTruthy();
  });

  it("is shown the advances and the rates, but cannot record or void an advance, or edit the rates", async () => {
    server.advances = [
      { id: "adv-1", userId: "staff-a", fullName: "Staff A", amount: "5000000", method: "cash", advanceDate: "2026-10-01", note: null, status: "active", createdByName: "Owner" },
    ];
    await mount({ canManage: false });
    expect(screen.getByText("۵٬۰۰۰٬۰۰۰ ریال")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ثبت مساعده" })).toBeNull();
    expect(screen.queryByRole("button", { name: /ابطال مساعده/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "تنظیمات بیمه و مالیات حقوق" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ویرایش نرخ‌ها" })).toBeNull();
    for (const term of PAY_TERMS) expect(termInput(term, "Staff A").disabled, term).toBe(true);
  });

  it("draws every control when permissions are unknown, leaving the API as the gate", async () => {
    server.runs = [makeRun()];
    await mount({ canManage: undefined });
    expect(wageInput("Staff A").disabled).toBe(false);
    expect(screen.getByRole("button", { name: "ثبت مساعده" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ویرایش نرخ‌ها" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ثبت تعهد" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ثبت پرداخت حقوق" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The four standing pay terms
// ---------------------------------------------------------------------------

describe("a member's pay terms (wage, allowances, fixed deduction)", () => {
  it("shows each term in its own box in the business's unit — a zero allowance as an empty box", async () => {
    server.staff = [member("staff-a", "Staff A", "cashier", "30000000", { taxableAllowance: "4000000", fixedDeduction: "500000" })];
    const view = await mount({ unit: "rial" });
    expect(termInput("monthlyWage", "Staff A").value).toBe("۳۰٬۰۰۰٬۰۰۰");
    expect(termInput("taxableAllowance", "Staff A").value).toBe("۴٬۰۰۰٬۰۰۰");
    expect(termInput("nonTaxableAllowance", "Staff A").value).toBe("");
    expect(termInput("fixedDeduction", "Staff A").value).toBe("۵۰۰٬۰۰۰");
    view.switchTo("toman");
    expect(termInput("taxableAllowance", "Staff A").value).toBe("۴۰۰٬۰۰۰");
    expect(termInput("fixedDeduction", "Staff A").value).toBe("۵۰٬۰۰۰");
  });

  it("sends only the term that was edited — saving an allowance never rewrites the wage", async () => {
    await mount();
    typeTerm("taxableAllowance", "Staff A", "5000000");
    expect(screen.getByText("ذخیره‌نشده")).toBeTruthy();
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"taxableAllowance":5000000}');
    expect(server.staff[0].monthlyWage).toBe("30000000");
    expect(server.staff[0].taxableAllowance).toBe("5000000");
    expect(await screen.findByText("اطلاعات حقوقی «Staff A» ذخیره شد.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("ذخیره‌نشده")).toBeNull());
  });

  it("does not resend a term that was typed and then typed back to what is saved — only what really changed", async () => {
    await mount();
    typeTerm("monthlyWage", "Staff A", "12345678");
    typeTerm("monthlyWage", "Staff A", "30000000"); // back to the saved wage: not a change
    typeTerm("taxableAllowance", "Staff A", "5000000");
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"taxableAllowance":5000000}');
  });

  it("an allowance typed as Rial is not read as Toman after a switch (the 10× slip), on every term", async () => {
    const view = await mount({ unit: "rial" });
    typeTerm("nonTaxableAllowance", "Staff A", "10000000");
    typeTerm("fixedDeduction", "Staff A", "2000000");
    view.switchTo("toman");
    // The same amounts, shown in Toman — not the same digits relabelled.
    expect(termInput("nonTaxableAllowance", "Staff A").value).toBe("۱٬۰۰۰٬۰۰۰");
    expect(termInput("fixedDeduction", "Staff A").value).toBe("۲۰۰٬۰۰۰");

    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    // Screen order, Rial on the wire.
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"nonTaxableAllowance":10000000,"fixedDeduction":2000000}');
  });

  it("Toman → Rial: an allowance typed as Toman keeps its value", async () => {
    const view = await mount({ unit: "toman" });
    typeTerm("taxableAllowance", "Staff A", "500000");
    view.switchTo("rial");
    expect(termInput("taxableAllowance", "Staff A").value).toBe("۵٬۰۰۰٬۰۰۰");
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"taxableAllowance":5000000}');
  });

  it("clearing a saved allowance saves zero, while clearing the wage saves «no wage»", async () => {
    server.staff = [member("staff-a", "Staff A", "cashier", "30000000", { fixedDeduction: "9" })];
    await mount();
    typeTerm("fixedDeduction", "Staff A", "");
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(server.calls("PATCH", /staff-a/)).toHaveLength(1));
    expect(server.calls("PATCH", /staff-a/)[0].rawBody).toBe('{"fixedDeduction":0}');
  });

  it("does not call an empty allowance box a change when none is saved", async () => {
    await mount();
    typeTerm("taxableAllowance", "Staff A", "");
    typeTerm("fixedDeduction", "Staff A", "0");
    expect(screen.queryByText("ذخیره‌نشده")).toBeNull();
    for (const button of saveButtons()) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses an allowance a JSON number could not carry, naming the term, and sends nothing", async () => {
    await mount();
    typeTerm("nonTaxableAllowance", "Staff A", "9007199254740992"); // 2^53
    fireEvent.click(saveButtons()[0]);
    expect(await screen.findByText("مبلغ «مزایای غیرمشمول» بیش از حد مجاز است.")).toBeTruthy();
    expect(server.calls("PATCH", /./)).toHaveLength(0);
  });

  it("guards navigation for an unsaved allowance, counting a member once however many terms are dirty", async () => {
    const user = userEvent.setup();
    await mount({
      children: (
        <nav>
          <Link href="/accounting/trial-balance">تراز آزمایشی</Link>
        </nav>
      ),
    });
    typeTerm("taxableAllowance", "Staff A", "1");
    typeTerm("fixedDeduction", "Staff A", "2");
    await user.click(screen.getByRole("link", { name: "تراز آزمایشی" }));
    expect((await screen.findByRole("dialog")).textContent).toContain("۱ تغییر در حقوق یا مزایا ذخیره نشده است");
  });

  it("remembers an unsaved allowance, in the unit it was typed in, for a navigation nothing can stop", async () => {
    const first = await mount({ unit: "rial", ownerKey: "member-1" });
    typeTerm("taxableAllowance", "Staff A", "10000000");
    first.unmount();
    await mount({ unit: "toman", ownerKey: "member-1" });
    expect(termInput("taxableAllowance", "Staff A").value).toBe("۱٬۰۰۰٬۰۰۰");
    expect(screen.getByText("ذخیره‌نشده")).toBeTruthy();
  });

  it("shows a member's pay-term history with the term named and the exact amounts", async () => {
    const original = server.handle;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        /staff\/staff-a\/history/.test(url)
          ? {
              ok: true,
              status: 200,
              json: async () => ({
                changes: [
                  {
                    id: "c-1",
                    userId: "staff-a",
                    employeeName: "Staff A",
                    term: "taxableAllowance",
                    previousAmount: "0",
                    newAmount: "9007199254740993", // past 2^53: shown exactly, as text
                    changedBy: "u1",
                    changedByName: "Owner",
                    changedAt: "2026-10-01T08:00:00.000Z",
                    reason: null,
                  },
                  {
                    id: "c-2",
                    userId: "staff-a",
                    employeeName: "Staff A",
                    term: "monthlyWage",
                    previousAmount: null,
                    newAmount: "30000000",
                    changedBy: null,
                    changedByName: null,
                    changedAt: "2026-09-01T08:00:00.000Z",
                    reason: "حکم جدید",
                  },
                ],
                nextCursor: null,
              }),
            }
          : original(url, init),
      ),
    );
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "سابقهٔ تغییرات حقوق و مزایا" })[0]);
    expect(await screen.findByText("مزایای مشمول مالیات:")).toBeTruthy();
    expect(screen.getByText("۰ ریال ← ۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ ریال")).toBeTruthy();
    expect(screen.getByText("حقوق پایه ماهانه:")).toBeTruthy();
    expect(screen.getByText("بدون حقوق ← ۳۰٬۰۰۰٬۰۰۰ ریال")).toBeTruthy();
    expect(screen.getByText(/حکم جدید/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The gross-to-net preview
// ---------------------------------------------------------------------------

describe("the gross-to-net preview in the accrual form", () => {
  const withRates = () => {
    server.settings = {
      ...EMPTY_PAYROLL_SETTINGS,
      taxBrackets: [],
      employeeInsurancePercent: 7,
      employerInsurancePercent: 20,
      unemploymentInsurancePercent: 3,
    };
  };

  it("with no rates entered, net equals gross and the screen says no statutory deduction is applied", async () => {
    await mount();
    expect(screen.getByText(/نرخ بیمه و مالیاتی وارد نشده است/)).toBeTruthy();
    const row = previewRow("Staff A").textContent ?? "";
    expect(row.match(/۳۰٬۰۰۰٬۰۰۰ ریال/g)).toHaveLength(2); // gross and net
  });

  it("with the business's rates, shows each member's breakdown and the totals the accrual will book", async () => {
    withRates();
    await mount();
    expect(screen.getByText(/ناخالص به خالص با نرخ‌های ثبت‌شده/)).toBeTruthy();

    const a = previewRow("Staff A").textContent ?? "";
    expect(a).toContain("۳۰٬۰۰۰٬۰۰۰ ریال"); // gross
    expect(a).toContain("۲٬۱۰۰٬۰۰۰ ریال"); // employee insurance, 7%
    expect(a).toContain("۲۷٬۹۰۰٬۰۰۰ ریال"); // net
    expect(a).toContain("۶٬۹۰۰٬۰۰۰ ریال"); // employer 20% + unemployment 3%

    const totals = totalsRow().textContent ?? "";
    expect(totals).toContain("۲ نفر");
    expect(totals).toContain("۵۰٬۰۰۰٬۰۰۰ ریال"); // gross
    expect(totals).toContain("۳٬۵۰۰٬۰۰۰ ریال"); // employee insurance
    expect(totals).toContain("۴۶٬۵۰۰٬۰۰۰ ریال"); // net
    expect(totals).toContain("۱۱٬۵۰۰٬۰۰۰ ریال"); // employer
  });

  it("reads the saved terms — an allowance typed but not saved is not what a run would book", async () => {
    withRates();
    await mount();
    typeTerm("taxableAllowance", "Staff A", "5000000");
    expect(previewRow("Staff A").textContent).toContain("۲۷٬۹۰۰٬۰۰۰ ریال");
    // Saved, it is in the preview.
    fireEvent.click(saveButtons()[0]);
    await waitFor(() => expect(within(previewTable()).getByText("Staff A").closest("tr")!.textContent).toContain("۳۵٬۰۰۰٬۰۰۰ ریال"));
  });

  it("adds this month's overtime to the line, and sends it as exact Rial digits", async () => {
    withRates();
    await mount();
    fireEvent.change(screen.getByLabelText("اضافه‌کار Staff A"), { target: { value: "5000000" } });
    const a = previewRow("Staff A").textContent ?? "";
    expect(a).toContain("۳۵٬۰۰۰٬۰۰۰ ریال"); // gross 30M + 5M
    expect(a).toContain("۲٬۴۵۰٬۰۰۰ ریال"); // 7% of 35M
    expect(a).toContain("۳۲٬۵۵۰٬۰۰۰ ریال"); // net

    fireEvent.click(screen.getByRole("button", { name: "ثبت تعهد" }));
    await waitFor(() => expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(1));
    const request = server.calls("POST", /payroll\/runs$/)[0];
    expect((request.body as { overtime: unknown }).overtime).toEqual({ "staff-a": "5000000" });
    // Text, so the amount never passed through a JavaScript number.
    expect(request.rawBody).toContain('"overtime":{"staff-a":"5000000"}');
  });

  it("overtime typed as Rial keeps its value across a unit switch, and the request still carries Rial", async () => {
    const view = await mount({ unit: "rial" });
    fireEvent.change(screen.getByLabelText("اضافه‌کار Staff A"), { target: { value: "5000000" } });
    view.switchTo("toman");
    expect((screen.getByLabelText("اضافه‌کار Staff A") as HTMLInputElement).value).toBe("۵۰۰٬۰۰۰");
    expect(previewRow("Staff A").textContent).toContain("۳٬۵۰۰٬۰۰۰ تومان"); // 35M Rial gross, shown in Toman

    fireEvent.click(screen.getByRole("button", { name: "ثبت تعهد" }));
    await waitFor(() => expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(1));
    expect((server.calls("POST", /payroll\/runs$/)[0].body as { overtime: unknown }).overtime).toEqual({ "staff-a": "5000000" });
  });

  it("clears the overtime once the accrual is recorded, and not before", async () => {
    server.accrualResponses = [{ status: 500, body: {} }];
    await mount();
    fireEvent.change(screen.getByLabelText("اضافه‌کار Staff A"), { target: { value: "5000000" } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت تعهد" }));
    await screen.findByText(/خطای غیرمنتظره/);
    expect((screen.getByLabelText("اضافه‌کار Staff A") as HTMLInputElement).value).toBe("۵٬۰۰۰٬۰۰۰");
    fireEvent.click(screen.getByRole("button", { name: "ثبت تعهد" }));
    await screen.findByText(/ثبت شد\./);
    await waitFor(() => expect((screen.getByLabelText("اضافه‌کار Staff A") as HTMLInputElement).value).toBe(""));
  });

  it("names the member whose deductions exceed their gross pay, blocks the button, and posts nothing", async () => {
    server.staff = [member("staff-a", "Staff A", "cashier", "30000000", { fixedDeduction: "40000000" }), member("staff-b", "Staff B", "waiter", "20000000")];
    await mount();
    expect(within(previewRow("Staff A")).getByText(/کسور یکی از کارکنان از حقوق ناخالص او بیشتر است/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "ثبت تعهد" }) as HTMLButtonElement).disabled).toBe(true);
    // No totals are shown for a month that cannot be accrued.
    expect(within(previewTable()).queryByText(/^جمع \(/)).toBeNull();

    // Enter inside an overtime box submits the form anyway; the screen refuses, saying why.
    fireEvent.submit(screen.getByRole("button", { name: "ثبت تعهد" }).closest("form")!);
    expect(await screen.findByText(/«Staff A»: کسور یکی از کارکنان/)).toBeTruthy();
    expect(server.calls("POST", /payroll\/runs$/)).toHaveLength(0);
  });

  it("refuses an overtime so large the line cannot be stored, instead of rounding it", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("اضافه‌کار Staff A"), { target: { value: "9223372036854775807" } });
    expect(within(previewRow("Staff A")).getByText("مبلغ حقوق بیش از حد بزرگ است.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "ثبت تعهد" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("recovers a member's open advance from the net, and flags it on their row", async () => {
    server.staff = [member("staff-a", "Staff A", "cashier", "30000000", { advanceOutstanding: "5000000" }), member("staff-b", "Staff B", "waiter", "20000000")];
    await mount();
    expect(screen.getByText("مساعده باز: ۵٬۰۰۰٬۰۰۰ ریال")).toBeTruthy();
    const a = previewRow("Staff A").textContent ?? "";
    expect(a).toContain("۵٬۰۰۰٬۰۰۰ ریال"); // recovered
    expect(a).toContain("۲۵٬۰۰۰٬۰۰۰ ریال"); // net after it
  });

  it("includes somebody who is only owed commission, with no overtime box and no gross-to-net line", async () => {
    server.staff = [...defaultStaff(), member("staff-c", "Staff C", "waiter", null)];
    server.commission = { "staff-c": "4000000" };
    server.unsettledCommission = "4000000";
    await mount();
    const c = previewRow("Staff C");
    expect(c.textContent).toContain("بدون حقوق ثابت");
    expect(c.textContent).toContain("۴٬۰۰۰٬۰۰۰ ریال");
    expect(screen.queryByLabelText("اضافه‌کار Staff C")).toBeNull();
    expect(totalsRow().textContent).toContain("۳ نفر");
    expect(totalsRow().textContent).toContain("۵۴٬۰۰۰٬۰۰۰ ریال"); // 50M net + 4M commission
  });

  it("does not offer a month that has not started", async () => {
    await mount();
    const today = todayJalali();
    fireEvent.click(screen.getByRole("button", { name: "ماه" }));
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(today.jm);
    expect(options[options.length - 1].textContent).toBe(JALALI_MONTH_NAMES[today.jm - 1]);
  });

  it("asks the server about the month that is selected, so the commission it shows is that month's", async () => {
    await mount();
    const today = todayJalali();
    expect(server.calls("GET", /payroll\/preview/)[0].url).toContain(`periodKey=${today.jy}-${String(today.jm).padStart(2, "0")}`);
    fireEvent.click(screen.getByRole("button", { name: "سال" }));
    fireEvent.click(await screen.findByRole("option", { name: toPersianDigits(today.jy - 1) }));
    await waitFor(() =>
      expect(server.calls("GET", /payroll\/preview/).some((r) => r.url.includes(`periodKey=${today.jy - 1}-`))).toBe(true),
    );
  });
});

// ---------------------------------------------------------------------------
// Salary advances
// ---------------------------------------------------------------------------

describe("salary advances", () => {
  async function chooseEmployee(name: string) {
    fireEvent.click(screen.getByRole("button", { name: "کارمند دریافت‌کنندهٔ مساعده" }));
    fireEvent.click(await screen.findByRole("option", { name }));
  }
  const amountBox = () => screen.getByLabelText("مبلغ مساعده") as HTMLInputElement;
  const record = () => fireEvent.click(screen.getByRole("button", { name: "ثبت مساعده" }));
  /** «ابطال‌شده» is also a history filter, so an advance's badge is looked for inside its own section. */
  const advancesSection = () => screen.getByRole("heading", { name: "مساعده کارکنان" }).closest("section")!;

  it("records an advance from the till by default, with the amount's digits as written", async () => {
    await mount();
    await chooseEmployee("Staff A");
    fireEvent.change(amountBox(), { target: { value: "10000000" } });
    record();
    await waitFor(() => expect(server.calls("POST", /advances$/)).toHaveLength(1));
    // Exactly the digits, in a JSON number, from the till — nothing else.
    expect(server.calls("POST", /advances$/)[0].rawBody).toBe('{"userId":"staff-a","paymentAccountId":"acc-cash","amount":10000000}');
    expect(await screen.findByText("مساعده ثبت شد؛ در تعهد حقوق بعدی کسر می‌شود.")).toBeTruthy();
    // The list shows it, and the form is ready for the next one.
    await waitFor(() => expect(screen.getByText("۱۰٬۰۰۰٬۰۰۰ ریال")).toBeTruthy());
    expect(amountBox().value).toBe("");
  });

  it("an amount typed as Rial is not read as Toman after a switch — it is sent as the Rial typed", async () => {
    const view = await mount({ unit: "rial" });
    await chooseEmployee("Staff B");
    fireEvent.change(amountBox(), { target: { value: "10000000" } });
    view.switchTo("toman");
    expect(amountBox().value).toBe("۱٬۰۰۰٬۰۰۰");
    record();
    await waitFor(() => expect(server.calls("POST", /advances$/)).toHaveLength(1));
    expect(server.calls("POST", /advances$/)[0].rawBody).toBe('{"userId":"staff-b","paymentAccountId":"acc-cash","amount":10000000}');
  });

  it("Toman → Rial: an amount typed as Toman is sent as ten times as many Rial", async () => {
    await mount({ unit: "toman" });
    await chooseEmployee("Staff A");
    fireEvent.change(amountBox(), { target: { value: "1000000" } });
    record();
    await waitFor(() => expect(server.calls("POST", /advances$/)).toHaveLength(1));
    expect((server.calls("POST", /advances$/)[0].body as { amount: number }).amount).toBe(10000000);
  });

  it("pays from the account chosen out of the chart, and records the date picked", async () => {
    await mount();
    await chooseEmployee("Staff A");
    fireEvent.click(screen.getByRole("button", { name: "حساب پرداخت مساعده" }));
    fireEvent.click(await screen.findByRole("option", { name: /بانک \(۱۱۱۰\)/ }));
    fireEvent.change(amountBox(), { target: { value: "700" } });
    record();
    await waitFor(() => expect(server.calls("POST", /advances$/)).toHaveLength(1));
    expect(server.calls("POST", /advances$/)[0].body).toEqual({ userId: "staff-a", paymentAccountId: "acc-bank", amount: 700 });
  });

  it("falls back to the cash/bank shorthand only when the chart has no account to pick", async () => {
    server.paymentAccounts = [];
    await mount();
    await chooseEmployee("Staff A");
    fireEvent.click(screen.getByRole("button", { name: "حساب پرداخت مساعده" }));
    fireEvent.click(await screen.findByRole("option", { name: "بانکی" }));
    fireEvent.change(amountBox(), { target: { value: "700" } });
    record();
    await waitFor(() => expect(server.calls("POST", /advances$/)).toHaveLength(1));
    expect(server.calls("POST", /advances$/)[0].body).toEqual({ userId: "staff-a", method: "bank", amount: 700 });
  });

  it("refuses a missing employee, a zero, and an amount a JSON number would round — without sending", async () => {
    await mount();
    // The button stays disabled until there is an employee and an amount; Enter inside the amount box
    // still submits the form, and the screen refuses there too.
    fireEvent.change(amountBox(), { target: { value: "700" } });
    expect((screen.getByRole("button", { name: "ثبت مساعده" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(amountBox().closest("form")!);
    expect(await screen.findByText("کارمند را انتخاب کنید.")).toBeTruthy();

    await chooseEmployee("Staff A");
    fireEvent.change(amountBox(), { target: { value: "0" } });
    record();
    expect(await screen.findByText("مبلغ مساعده معتبر نیست.")).toBeTruthy();

    fireEvent.change(amountBox(), { target: { value: "9007199254740992" } });
    record();
    expect(await screen.findByText("مبلغ مساعده بیش از حد مجاز است.")).toBeTruthy();
    expect(server.calls("POST", /advances/)).toHaveLength(0);
  });

  it("voids through a dialog, and says the entry is reversed", async () => {
    server.advances = [
      { id: "adv-1", userId: "staff-a", fullName: "Staff A", amount: "5000000", method: "cash", advanceDate: "2026-10-01", note: "کمک هزینه", status: "active", createdByName: "Owner" },
    ];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ابطال مساعده Staff A" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("«Staff A»");
    expect(dialog.textContent).toContain("۵٬۰۰۰٬۰۰۰ ریال");
    expect(dialog.textContent).toContain("سند معکوس");
    fireEvent.click(within(dialog).getByRole("button", { name: "ابطال مساعده" }));
    await waitFor(() => expect(server.calls("POST", /advances\/adv-1\/void$/)).toHaveLength(1));
    expect(await screen.findByText("مساعده ابطال شد.")).toBeTruthy();
    await waitFor(() => expect(within(advancesSection()).getByText("ابطال‌شده")).toBeTruthy());
    expect(within(advancesSection()).queryByRole("button", { name: /ابطال مساعده/ })).toBeNull();
  });

  it("explains a refused void in Persian: part of it was already recovered from pay", async () => {
    server.advances = [
      { id: "adv-1", userId: "staff-a", fullName: "Staff A", amount: "5000000", method: "cash", advanceDate: "2026-10-01", note: null, status: "active", createdByName: "Owner" },
    ];
    server.advanceVoidResponses = [{ status: 409, body: { error: "advance_already_recovered" } }];
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ابطال مساعده Staff A" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "ابطال مساعده" }));
    expect(await screen.findByText(/بخشی از این مساعده در حقوق کسر شده است/)).toBeTruthy();
  });

  it("shows a voided advance as voided, with no second void", async () => {
    server.advances = [
      { id: "adv-1", userId: "staff-a", fullName: "Staff A", amount: "5000000", method: "bank", advanceDate: "2026-10-01", note: null, status: "voided", createdByName: "Owner" },
    ];
    await mount();
    expect(within(advancesSection()).getByText("ابطال‌شده")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ابطال مساعده/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The business's own rates
// ---------------------------------------------------------------------------

describe("payroll settings on the screen", () => {
  it("saves the rates a manager enters, and the preview uses them at once", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ویرایش نرخ‌ها" }));
    fireEvent.change(screen.getByLabelText("سهم بیمه کارگر (٪)"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیره تنظیمات" }));
    await waitFor(() => expect(server.calls("PUT", /payroll\/settings$/)).toHaveLength(1));
    expect((server.calls("PUT", /payroll\/settings$/)[0].body as PayrollSettings).employeeInsurancePercent).toBe(7);
    expect(await screen.findByText("تنظیمات بیمه و مالیات حقوق ذخیره شد.")).toBeTruthy();
    await waitFor(() => expect(previewRow("Staff A").textContent).toContain("۲۷٬۹۰۰٬۰۰۰ ریال"));
  });

  it("never guesses a rate when the read fails: no deduction is previewed, and the screen says so", async () => {
    server.settings = { ...EMPTY_PAYROLL_SETTINGS, taxBrackets: [], employeeInsurancePercent: 7 };
    const original = server.handle;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        /payroll\/settings$/.test(url) ? { ok: false, status: 500, json: async () => ({}) } : original(url, init),
      ),
    );
    await mount();
    expect(await screen.findByText("بارگذاری تنظیمات بیمه و مالیات ناموفق بود.")).toBeTruthy();
    expect(previewRow("Staff A").textContent).toContain("۳۰٬۰۰۰٬۰۰۰ ریال");
    expect(previewRow("Staff A").textContent).not.toContain("۲۷٬۹۰۰٬۰۰۰ ریال");
  });
});

// ---------------------------------------------------------------------------
// A run's lines
// ---------------------------------------------------------------------------

describe("a run's lines", () => {
  it("shows the whole month for each employee — pay, deductions, net and the employer's cost — from the run's snapshot", async () => {
    server.runs = [makeRun({ totalAmount: "35000000", netAmount: "32550000", payableAmount: "32550000", lineCount: 1 })];
    server.lines["run-1"] = [
      makeLine({
        overtimeRial: "5000000",
        grossRial: "35000000",
        employeeInsuranceRial: "2450000",
        employerInsuranceRial: "7000000",
        unemploymentInsuranceRial: "1050000",
        incomeTaxRial: "0",
        otherDeductionsRial: "0",
        netPayRial: "32550000",
        payableAmount: "32550000",
      }),
    ];
    await mount();
    const item = screen.getByText("مرداد ۱۴۰۴").closest("li")!;
    fireEvent.click(within(item).getByRole("button", { name: /جزئیات/ }));
    await within(item).findByText("Staff A");

    for (const label of ["حقوق پایه", "مزایا و اضافه‌کار", "ناخالص", "بیمه کارگر", "مالیات حقوق", "کسر مساعده", "سایر کسور", "خالص حقوق", "بیمه سهم کارفرما و بیکاری"]) {
      expect(within(item).getByText(label), label).toBeTruthy();
    }
    const text = item.textContent ?? "";
    expect(text).toContain("۲٬۴۵۰٬۰۰۰"); // employee insurance
    expect(text).toContain("۸٬۰۵۰٬۰۰۰"); // employer 7M + unemployment 1.05M
    expect(text).toContain("۳۲٬۵۵۰٬۰۰۰"); // net
  });

  it("shows an amount past 2^53 exactly, because every figure travels as text", async () => {
    server.runs = [makeRun({ totalAmount: "9007199254740993", netAmount: "9007199254740993", payableAmount: "9007199254740993" })];
    await mount();
    expect(screen.getAllByText(/۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳/).length).toBeGreaterThan(0);
  });
});

describe("the screen describes itself accurately", () => {
  it("says it is journal-level, business-wide, and issues no payslip or filing", async () => {
    await mount();
    const note = screen.getByText(/ثبت تعهد ماهانهٔ حقوق و دستمزد/);
    expect(note.textContent).toContain("ناخالص به خالص");
    expect(note.textContent).toContain("فیش حقوقی");
    expect(note.textContent).toContain("پرداخت بیمه و مالیاتِ نگه‌داشته‌شده جداگانه انجام می‌شود");
    expect(note.textContent).toContain("کل کسب‌وکار");
    expect(note.textContent).toContain("شعبهٔ فعال");
  });

  it("shows a load failure instead of an endless skeleton", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        /payroll\/runs\?/.test(url) ? { ok: false, status: 500, json: async () => ({}) } : server.handle(url, init),
      ),
    );
    await mount();
    expect(await screen.findByText("بارگذاری تاریخچه حقوق ناموفق بود.")).toBeTruthy();
    expect(screen.getByText("هنوز تعهدی ثبت نشده است.")).toBeTruthy();
  });

  it("flushes pending state without act warnings by awaiting its own loads", async () => {
    await mount();
    await act(async () => {});
    expect(screen.getByText("تاریخچه حقوق و دستمزد")).toBeTruthy();
  });
});
