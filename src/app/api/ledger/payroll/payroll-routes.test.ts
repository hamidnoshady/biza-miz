import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as service from "@/lib/payroll-service";
import * as advancesService from "@/lib/payroll-advances-service";
import * as accounts from "@/lib/payroll-accounts";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { PayrollError } from "@/lib/payroll-errors";
import { PERMISSIONS } from "@/lib/permissions";
import { GET as listRuns, POST as accrueRun } from "./runs/route";
import { GET as getRun } from "./runs/[id]/route";
import { POST as payRun } from "./runs/[id]/pay/route";
import { POST as voidRun } from "./runs/[id]/void/route";
import { GET as listStaff } from "./staff/route";
import { GET as wageHistory } from "./staff/[id]/history/route";
import { GET as preview } from "./preview/route";
import { GET as listAdvances, POST as recordAdvance } from "./advances/route";
import { POST as voidAdvance } from "./advances/[id]/void/route";
import { GET as getSettings, PUT as putSettings } from "./settings/route";

/**
 * The payroll HTTP surface — issue #835 §1, §3, §4, §8, §9, §11, §14, and the
 * advances and settings routes audit F11 added to it.
 *
 * The service is mocked; these tests drive the real route handlers, so they pin
 * what the *routes* promise: which capability each one needs (`payroll.view`
 * and `payroll.manage` stay separate), that a body that is not a JSON object is
 * a 400 and not a `TypeError`, how a refusal reaches the screen, and that no
 * mutating route consults the caller's active branch any more.
 */
vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/payroll-service", () => ({
  accruePayroll: vi.fn(),
  listPayrollRuns: vi.fn(),
  getPayrollRun: vi.fn(),
  payPayroll: vi.fn(),
  voidPayrollRun: vi.fn(),
  listStaffWages: vi.fn(),
  listPayTermChanges: vi.fn(),
  previewCommission: vi.fn(),
  getPayrollLiability: vi.fn(),
  getPayrollSettings: vi.fn(),
  savePayrollSettings: vi.fn(),
  setStaffPayTerms: vi.fn(),
}));
vi.mock("@/lib/payroll-advances-service", () => ({
  listAdvances: vi.fn(),
  recordAdvance: vi.fn(),
  voidAdvance: vi.fn(),
}));
vi.mock("@/lib/payroll-accounts", () => ({
  listPaymentAccounts: vi.fn(),
}));
// A mutating payroll route must not need the active branch. If one ever calls
// this again, the test that exercises it fails loudly instead of posting to it.
vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(() => {
    throw new Error("payroll must not depend on the caller's active branch");
  }),
}));

const session = { businessId: "business-1", sub: "accountant-1", role: "accountant" };
const RUN_ID = "0b9f6a52-3c1e-4c2f-9f0a-7a0a1f4f2f11";
const ctx = { params: Promise.resolve({ id: RUN_ID }) };

const ADVANCE_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const advCtx = { params: Promise.resolve({ id: ADVANCE_ID }) };
const ADVANCE = { id: ADVANCE_ID, userId: RUN_ID, amount: "5000000", method: "cash", status: "active" };

const RUN = {
  id: RUN_ID,
  periodLabel: "مرداد 1404",
  periodKey: "1404-05",
  status: "accrued",
  totalAmount: "50000000",
  netAmount: "50000000",
  commissionTotal: "0",
  payableAmount: "50000000",
  accrualDate: "2025-08-01",
  paidDate: null,
  voidedDate: null,
  createdByName: "Owner",
  lineCount: 2,
  lines: [],
};

function request(path: string, init: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const body = init.raw !== undefined ? init.raw : init.body === undefined ? undefined : JSON.stringify(init.body);
  return new NextRequest(`http://localhost/api/ledger/payroll/${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body,
  });
}

const forbidden = () =>
  ({
    session: null,
    error: NextResponse.json({ error: "forbidden", code: "MISSING_PERMISSION" }, { status: 403 }),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(service.accruePayroll).mockResolvedValue({ ...RUN, idempotentReplay: false } as never);
  vi.mocked(service.listPayrollRuns).mockResolvedValue({ runs: [RUN], nextCursor: null } as never);
  vi.mocked(service.getPayrollRun).mockResolvedValue(RUN as never);
  vi.mocked(service.payPayroll).mockResolvedValue({ ...RUN, status: "paid" } as never);
  vi.mocked(service.voidPayrollRun).mockResolvedValue({ ...RUN, status: "voided" } as never);
  vi.mocked(service.listStaffWages).mockResolvedValue([]);
  vi.mocked(service.listPayTermChanges).mockResolvedValue({ changes: [], nextCursor: null });
  vi.mocked(service.previewCommission).mockResolvedValue({ accrualDate: "2025-08-22", lines: [], total: "0" });
  vi.mocked(service.getPayrollLiability).mockResolvedValue({ difference: "0" } as never);
  vi.mocked(accounts.listPaymentAccounts).mockResolvedValue([]);
  vi.mocked(service.getPayrollSettings).mockResolvedValue({ taxBrackets: [] } as never);
  vi.mocked(service.savePayrollSettings).mockResolvedValue({ taxBrackets: [] } as never);
  vi.mocked(advancesService.listAdvances).mockResolvedValue([ADVANCE] as never);
  vi.mocked(advancesService.recordAdvance).mockResolvedValue(ADVANCE as never);
  vi.mocked(advancesService.voidAdvance).mockResolvedValue({ ...ADVANCE, status: "voided" } as never);
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("payroll routes — payroll.view and payroll.manage stay separate", () => {
  const reads: Array<[string, () => Promise<Response>, () => unknown]> = [
    ["GET runs", () => listRuns(request("runs")), () => service.listPayrollRuns],
    ["GET runs/:id", () => getRun(request(`runs/${RUN_ID}`), ctx), () => service.getPayrollRun],
    ["GET staff", () => listStaff(), () => service.listStaffWages],
    ["GET staff/:id/history", () => wageHistory(request(`staff/${RUN_ID}/history`), ctx), () => service.listPayTermChanges],
    ["GET preview", () => preview(request("preview")), () => service.previewCommission],
    ["GET advances", () => listAdvances(), () => advancesService.listAdvances],
    ["GET settings", () => getSettings(), () => service.getPayrollSettings],
  ];
  const writes: Array<[string, () => Promise<Response>, () => unknown]> = [
    ["POST runs", () => accrueRun(request("runs", { method: "POST", body: { periodKey: "1404-05" } })), () => service.accruePayroll],
    ["POST runs/:id/pay", () => payRun(request(`runs/${RUN_ID}/pay`, { method: "POST", body: {} }), ctx), () => service.payPayroll],
    ["POST runs/:id/void", () => voidRun(request(`runs/${RUN_ID}/void`, { method: "POST" }), ctx), () => service.voidPayrollRun],
    [
      "POST advances",
      () => recordAdvance(request("advances", { method: "POST", body: { userId: RUN_ID, amount: 5 } })),
      () => advancesService.recordAdvance,
    ],
    [
      "POST advances/:id/void",
      () => voidAdvance(request(`advances/${ADVANCE_ID}/void`, { method: "POST" }), advCtx),
      () => advancesService.voidAdvance,
    ],
    ["PUT settings", () => putSettings(request("settings", { method: "PUT", body: {} })), () => service.savePayrollSettings],
  ];

  it.each(reads)("%s needs payroll.view and nothing weaker", async (_name, call) => {
    await call();
    expect(auth.requirePermission).toHaveBeenCalledTimes(1);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.payrollView);
  });

  it.each(writes)("%s needs payroll.manage — viewing is not enough", async (_name, call) => {
    await call();
    expect(auth.requirePermission).toHaveBeenCalledTimes(1);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.payrollManage);
  });

  it.each([...reads, ...writes])("%s answers a canonical 403 and touches nothing", async (_name, call, serviceFn) => {
    vi.mocked(auth.requirePermission).mockResolvedValue(forbidden());
    const response = await call();
    expect(response.status).toBe(403);
    expect(serviceFn()).not.toHaveBeenCalled();
  });

  it("never lets a ledger or finance capability stand in for a payroll one", () => {
    const root = join(process.cwd(), "src/app/api/ledger/payroll");
    for (const file of [
      "runs/route.ts",
      "runs/[id]/route.ts",
      "runs/[id]/pay/route.ts",
      "runs/[id]/void/route.ts",
      "staff/route.ts",
      "staff/[id]/route.ts",
      "staff/[id]/history/route.ts",
      "preview/route.ts",
      "advances/route.ts",
      "advances/[id]/void/route.ts",
      "settings/route.ts",
    ]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, file).toMatch(/PERMISSIONS\.payroll(View|Manage)/);
      expect(source, file).not.toMatch(/PERMISSIONS\.(ledger\w+|accountsEdit|finance\w+)/);
      expect(source, file).not.toMatch(/requireRole\(/);
    }
  });
});

describe("payroll routes — no mutating route consults the caller's active branch (issue #835 §1)", () => {
  it("does not import or call resolveActiveLocation anywhere in the payroll API", () => {
    const root = join(process.cwd(), "src/app/api/ledger/payroll");
    for (const file of [
      "runs/route.ts",
      "runs/[id]/pay/route.ts",
      "runs/[id]/void/route.ts",
      "staff/[id]/route.ts",
      "advances/route.ts",
      "advances/[id]/void/route.ts",
      "settings/route.ts",
    ]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, file).not.toContain("resolveActiveLocation");
      expect(source, file).not.toContain("setup-state");
      expect(source, file).not.toMatch(/locationId/);
    }
  });

  it("accrues, pays and voids without a location, and works while the branch lookup would throw", async () => {
    expect((await accrueRun(request("runs", { method: "POST", body: { periodKey: "1404-05" } }))).status).toBe(201);
    expect((await payRun(request(`runs/${RUN_ID}/pay`, { method: "POST", body: {} }), ctx)).status).toBe(200);
    expect((await voidRun(request(`runs/${RUN_ID}/void`, { method: "POST" }), ctx)).status).toBe(200);
    expect((await recordAdvance(request("advances", { method: "POST", body: { userId: RUN_ID, amount: 5 } }))).status).toBe(201);
    expect((await voidAdvance(request(`advances/${ADVANCE_ID}/void`, { method: "POST" }), advCtx)).status).toBe(200);
    for (const mock of [
      service.accruePayroll,
      service.payPayroll,
      service.voidPayrollRun,
      advancesService.recordAdvance,
      advancesService.voidAdvance,
    ]) {
      expect(vi.mocked(mock).mock.calls[0][0]).not.toHaveProperty("locationId");
    }
  });
});

// ---------------------------------------------------------------------------
// Accrual — validation, idempotency, duplicates
// ---------------------------------------------------------------------------

describe("POST /api/ledger/payroll/runs", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    accrueRun(request("runs", { method: "POST", body, headers }));

  it("accrues a month and answers 201 with the run", async () => {
    const response = await post({ periodKey: "1404-05", accrualDate: "2025-08-01" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ run: { id: RUN_ID, status: "accrued" }, idempotentReplay: false });
    expect(service.accruePayroll).toHaveBeenCalledWith({
      businessId: "business-1",
      createdBy: "accountant-1",
      periodKey: "1404-05",
      accrualDate: "2025-08-01",
      overtime: null,
      idempotencyKey: null,
      includeCommission: undefined,
    });
  });

  it("passes this month's overtime and the commission option to the service", async () => {
    await post({ periodKey: "1404-05", overtime: { [RUN_ID]: 1_000_000 }, includeCommission: false });
    expect(service.accruePayroll).toHaveBeenCalledWith(
      expect.objectContaining({ overtime: { [RUN_ID]: 1_000_000 }, includeCommission: false }),
    );
  });

  it("leaves the spelling of the key to the service (it normalises digits, dashes and spaces)", async () => {
    await post({ periodKey: " ۱۴۰۴-۰۵ " });
    expect(service.accruePayroll).toHaveBeenCalledWith(expect.objectContaining({ periodKey: " ۱۴۰۴-۰۵ " }));
  });

  it("passes the idempotency key from the header, or from the body", async () => {
    await post({ periodKey: "1404-05" }, { "Idempotency-Key": "retry-key-0001" });
    expect(service.accruePayroll).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: "retry-key-0001" }));
    await post({ periodKey: "1404-05", idempotencyKey: "retry-key-0002" });
    expect(service.accruePayroll).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: "retry-key-0002" }));
    await post({ periodKey: "1404-05", idempotencyKey: "retry-key-0003" }, { "Idempotency-Key": "retry-key-0003" });
    expect(service.accruePayroll).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: "retry-key-0003" }));
  });

  it("refuses a header and a body key that disagree", async () => {
    const response = await post({ periodKey: "1404-05", idempotencyKey: "retry-key-0002" }, { "Idempotency-Key": "retry-key-0001" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_invalid" });
    expect(service.accruePayroll).not.toHaveBeenCalled();
  });

  it("answers a replayed request 200 and says so, instead of 201", async () => {
    vi.mocked(service.accruePayroll).mockResolvedValue({ ...RUN, idempotentReplay: true } as never);
    const response = await post({ periodKey: "1404-05", idempotencyKey: "retry-key-0001" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { id: RUN_ID }, idempotentReplay: true });
    expect(await (await post({ periodKey: "1404-05" })).json()).not.toHaveProperty("run.idempotentReplay");
  });

  it("answers a duplicate period 409 and names the run that already stands", async () => {
    vi.mocked(service.accruePayroll).mockRejectedValue(
      new PayrollError("period_already_accrued", 409, { run: { id: RUN_ID, periodLabel: "مرداد 1404", status: "paid" } }),
    );
    const response = await post({ periodKey: "1404-05" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "period_already_accrued",
      run: { id: RUN_ID, periodLabel: "مرداد 1404", status: "paid" },
    });
  });

  it("answers a key reused for another period 409", async () => {
    vi.mocked(service.accruePayroll).mockRejectedValue(new PayrollError("idempotency_key_conflict", 409));
    const response = await post({ periodKey: "1404-06", idempotencyKey: "retry-key-0001" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "idempotency_key_conflict" });
  });

  it.each([
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a string", '"مرداد"'],
    ["malformed JSON", "{periodKey"],
    ["an empty body", ""],
  ])("answers 400 bad_request for a body that is %s", async (_name, raw) => {
    const response = await accrueRun(request("runs", { method: "POST", raw }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(service.accruePayroll).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "invalid_period"],
    [{ periodKey: 140405 }, "invalid_period"],
    [{ periodKey: null }, "invalid_period"],
    [{ periodKey: { year: 1404, month: 5 } }, "invalid_period"],
    [{ periodKey: ["1404-05"] }, "invalid_period"],
    [{ periodKey: "1404-05", accrualDate: 20250801 }, "invalid_accrual_date"],
    [{ periodKey: "1404-05", accrualDate: {} }, "invalid_accrual_date"],
    [{ periodKey: "1404-05", overtime: [] }, "invalid_overtime"],
    [{ periodKey: "1404-05", overtime: "5" }, "invalid_overtime"],
    [{ periodKey: "1404-05", includeCommission: "yes" }, "bad_request"],
    [{ periodKey: "1404-05", includeCommission: 1 }, "bad_request"],
    [{ periodKey: "1404-05", idempotencyKey: 12345678 }, "idempotency_key_invalid"],
  ])("rejects %j with %s before reaching the service", async (body, code) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(service.accruePayroll).not.toHaveBeenCalled();
  });

  it("maps a missing system account and a fiscal-period lock to 409", async () => {
    vi.mocked(service.accruePayroll).mockRejectedValue(new MissingLedgerAccountError("5200"));
    const missing = await post({ periodKey: "1404-05" });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "ledger_account_missing", code: "5200" });

    vi.mocked(service.accruePayroll).mockRejectedValue(new Error("fiscal_period_locked"));
    const locked = await post({ periodKey: "1404-05" });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ error: "fiscal_period_locked" });
  });

  it("does not turn an unexpected failure into a 4xx", async () => {
    vi.mocked(service.accruePayroll).mockRejectedValue(new Error("connection reset"));
    await expect(post({ periodKey: "1404-05" })).rejects.toThrow("connection reset");
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe("GET /api/ledger/payroll/runs — bounded, filtered, cursor-paginated", () => {
  it("passes the filters and cursor to the service and returns the page", async () => {
    vi.mocked(service.listPayrollRuns).mockResolvedValue({ runs: [RUN], nextCursor: "next-page" } as never);
    const cursor = Buffer.from(
      JSON.stringify({ d: "2025-08-01", c: "2025-08-01 10:00:00.123456+00", i: RUN_ID }),
    ).toString("base64url");
    const response = await listRuns(
      request(`runs?limit=5&status=paid&from=2025-01-01&to=2025-12-31&period=${encodeURIComponent("مرداد ۱۴۰۴")}&cursor=${cursor}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [RUN], nextCursor: "next-page" });
    expect(service.listPayrollRuns).toHaveBeenCalledWith("business-1", {
      limit: 5,
      status: "paid",
      from: "2025-01-01",
      to: "2025-12-31",
      period: "مرداد ۱۴۰۴",
      cursor,
    });
  });

  it("asks for the default first page when no query is given, and never for lines", async () => {
    await listRuns(request("runs"));
    expect(service.listPayrollRuns).toHaveBeenCalledWith("business-1", {});
    await listRuns(request("runs?includeLines=true"));
    expect(vi.mocked(service.listPayrollRuns).mock.calls[1][1]).not.toHaveProperty("includeLines");
  });

  it.each([
    ["status=banana", "invalid_run_status"],
    ["from=banana", "invalid_date"],
    ["to=2025-02-31", "invalid_date"],
    ["from=2025-10-05&to=2025-10-01", "invalid_date"],
    ["limit=abc", "invalid_limit"],
    ["limit=-1", "invalid_limit"],
    ["cursor=forged", "invalid_cursor"],
  ])("answers 400 %s → %s without querying", async (query, code) => {
    const response = await listRuns(request(`runs?${query}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(service.listPayrollRuns).not.toHaveBeenCalled();
  });

  it("serves one run with its lines from the detail route, and 404s an unknown one", async () => {
    const found = await getRun(request(`runs/${RUN_ID}`), ctx);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ run: RUN });
    expect(service.getPayrollRun).toHaveBeenCalledWith("business-1", RUN_ID);

    vi.mocked(service.getPayrollRun).mockResolvedValue(null);
    const missing = await getRun(request(`runs/${RUN_ID}`), ctx);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "run_not_found" });
  });
});

describe("GET /api/ledger/payroll/staff/:id/history — pay-term audit, behind payroll.view", () => {
  it("returns the member's changes and passes the paging through", async () => {
    vi.mocked(service.listPayTermChanges).mockResolvedValue({
      changes: [{ id: "c1", term: "monthlyWage", previousAmount: "1", newAmount: "2" }],
      nextCursor: null,
    } as never);
    const response = await wageHistory(request(`staff/${RUN_ID}/history?limit=10`), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changes: [{ id: "c1", term: "monthlyWage", previousAmount: "1", newAmount: "2" }] });
    expect(service.listPayTermChanges).toHaveBeenCalledWith("business-1", RUN_ID, { limit: 10, cursor: undefined });
  });

  it("answers 400 for a bad limit or cursor, and a service refusal with its own status", async () => {
    expect((await wageHistory(request(`staff/${RUN_ID}/history?limit=zero`), ctx)).status).toBe(400);
    expect((await wageHistory(request(`staff/${RUN_ID}/history?cursor=forged`), ctx)).status).toBe(400);
    expect(service.listPayTermChanges).not.toHaveBeenCalled();
    vi.mocked(service.listPayTermChanges).mockRejectedValue(new PayrollError("user_not_found", 404));
    expect((await wageHistory(request(`staff/nope/history`), ctx)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

describe("POST /api/ledger/payroll/runs/:id/pay", () => {
  const post = (body: unknown) => payRun(request(`runs/${RUN_ID}/pay`, { method: "POST", body }), ctx);

  it("pays from cash today when the body is empty — and never a location", async () => {
    const empty = await payRun(request(`runs/${RUN_ID}/pay`, { method: "POST", raw: "" }), ctx);
    expect(empty.status).toBe(200);
    expect(service.payPayroll).toHaveBeenCalledWith({
      businessId: "business-1",
      runId: RUN_ID,
      method: "cash",
      paymentAccountId: null,
      paidDate: undefined,
      actorId: "accountant-1",
    });
  });

  it("passes the chosen payment account and the ISO payment date to the service", async () => {
    const accountId = "11111111-2222-4333-8444-555555555555";
    const response = await post({ paymentAccountId: accountId, paidDate: "2025-08-05" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { status: "paid" } });
    expect(service.payPayroll).toHaveBeenCalledWith(
      expect.objectContaining({ paymentAccountId: accountId, paidDate: "2025-08-05", method: "cash" }),
    );
    await post({ method: "bank" });
    expect(service.payPayroll).toHaveBeenLastCalledWith(expect.objectContaining({ method: "bank", paymentAccountId: null }));
  });

  it.each([
    [{ method: "crypto" }, "invalid_method"],
    [{ method: 1 }, "invalid_method"],
    [{ method: null }, "invalid_method"],
    [{ paymentAccountId: 7 }, "invalid_payment_account"],
    [{ paymentAccountId: {} }, "invalid_payment_account"],
    [{ paidDate: 20250805 }, "invalid_paid_date"],
    [{ paidDate: [] }, "invalid_paid_date"],
  ])("rejects %j with %s", async (body, code) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(service.payPayroll).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON null", "null"],
    ["an array", "[]"],
    ["malformed JSON", "{method"],
  ])("refuses a present body that is %s instead of silently paying out of cash", async (_name, raw) => {
    const response = await payRun(request(`runs/${RUN_ID}/pay`, { method: "POST", raw }), ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(service.payPayroll).not.toHaveBeenCalled();
  });

  it.each([
    ["paid_date_before_accrual", 400],
    ["invalid_payment_account", 400],
    ["invalid_paid_date", 400],
    ["already_paid", 409],
    ["run_voided", 409],
    ["run_not_found", 404],
  ])("surfaces %s as %i", async (code, status) => {
    vi.mocked(service.payPayroll).mockRejectedValue(new PayrollError(code, status));
    const response = await post({});
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
});

// ---------------------------------------------------------------------------
// Void and the screen's reads
// ---------------------------------------------------------------------------

describe("POST /api/ledger/payroll/runs/:id/void", () => {
  it("voids with the actor and the run id only", async () => {
    const response = await voidRun(request(`runs/${RUN_ID}/void`, { method: "POST" }), ctx);
    expect(response.status).toBe(200);
    expect(service.voidPayrollRun).toHaveBeenCalledWith({ businessId: "business-1", runId: RUN_ID, actorId: "accountant-1" });
  });

  it("surfaces an already-voided run as 409", async () => {
    vi.mocked(service.voidPayrollRun).mockRejectedValue(new PayrollError("already_voided", 409));
    const response = await voidRun(request(`runs/${RUN_ID}/void`, { method: "POST" }), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_voided" });
  });
});

describe("GET /api/ledger/payroll/preview", () => {
  it("returns the commission preview, the liability tie-out and the payment accounts together", async () => {
    vi.mocked(service.previewCommission).mockResolvedValue({ accrualDate: "2025-08-22", lines: [], total: "5" });
    vi.mocked(service.getPayrollLiability).mockResolvedValue({ ledgerBalance: "5", difference: "0" } as never);
    vi.mocked(accounts.listPaymentAccounts).mockResolvedValue([{ id: "a", code: "1100", name: "صندوق", role: "cash" }]);
    const response = await preview(request("preview?periodKey=1404-05&accrualDate=2025-08-01&includeCommission=false"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commission: { accrualDate: "2025-08-22", lines: [], total: "5" },
      liability: { ledgerBalance: "5", difference: "0" },
      paymentAccounts: [{ id: "a", code: "1100", name: "صندوق", role: "cash" }],
    });
    expect(service.previewCommission).toHaveBeenCalledWith("business-1", {
      periodKey: "1404-05",
      accrualDate: "2025-08-01",
      includeCommission: false,
    });
  });

  it("includes commission by default and refuses a non-boolean flag", async () => {
    await preview(request("preview"));
    expect(service.previewCommission).toHaveBeenCalledWith("business-1", { periodKey: null, accrualDate: null, includeCommission: true });
    const response = await preview(request("preview?includeCommission=maybe"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
  });

  it("maps a malformed date or month to a controlled 400", async () => {
    vi.mocked(service.previewCommission).mockRejectedValue(new PayrollError("invalid_accrual_date"));
    const date = await preview(request("preview?accrualDate=banana"));
    expect(date.status).toBe(400);
    expect(await date.json()).toEqual({ error: "invalid_accrual_date" });

    vi.mocked(service.previewCommission).mockRejectedValue(new PayrollError("invalid_period"));
    const month = await preview(request("preview?periodKey=1404-13"));
    expect(month.status).toBe(400);
    expect(await month.json()).toEqual({ error: "invalid_period" });
  });
});

// ---------------------------------------------------------------------------
// Salary advances and the settings document (audit F11) — under the #835 rules
// ---------------------------------------------------------------------------

describe("GET /api/ledger/payroll/advances", () => {
  it("lists the business's advances", async () => {
    const response = await listAdvances();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ advances: [ADVANCE] });
    expect(advancesService.listAdvances).toHaveBeenCalledWith("business-1");
  });
});

describe("POST /api/ledger/payroll/advances", () => {
  const post = (body: unknown) => recordAdvance(request("advances", { method: "POST", body }));
  const accountId = "11111111-2222-4333-8444-555555555555";

  it("records an advance business-wide (no location), from cash unless told otherwise", async () => {
    const response = await post({ userId: RUN_ID, amount: 5_000_000, advanceDate: "2025-08-01", note: "  اضافه  " });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ advance: ADVANCE });
    expect(advancesService.recordAdvance).toHaveBeenCalledWith({
      businessId: "business-1",
      userId: RUN_ID,
      amount: 5_000_000,
      method: "cash",
      paymentAccountId: null,
      advanceDate: "2025-08-01",
      note: "  اضافه  ",
      createdBy: "accountant-1",
    });
  });

  it("passes a chosen bank method or payout account through", async () => {
    await post({ userId: RUN_ID, amount: 5, method: "bank" });
    expect(advancesService.recordAdvance).toHaveBeenLastCalledWith(expect.objectContaining({ method: "bank", paymentAccountId: null }));
    await post({ userId: RUN_ID, amount: 5, paymentAccountId: accountId });
    expect(advancesService.recordAdvance).toHaveBeenLastCalledWith(expect.objectContaining({ paymentAccountId: accountId }));
  });

  it.each([
    [{ userId: RUN_ID, amount: "5000000" }, "invalid_amount"],
    [{ userId: RUN_ID, amount: true }, "invalid_amount"],
    [{ userId: RUN_ID, amount: null }, "invalid_amount"],
    [{ userId: RUN_ID }, "invalid_amount"],
    [{ userId: RUN_ID, amount: [5] }, "invalid_amount"],
    [{ userId: RUN_ID, amount: 5, method: "crypto" }, "invalid_method"],
    [{ userId: RUN_ID, amount: 5, method: null }, "invalid_method"],
    [{ userId: RUN_ID, amount: 5, paymentAccountId: 7 }, "invalid_payment_account"],
    [{ userId: RUN_ID, amount: 5, advanceDate: 20250801 }, "invalid_advance_date"],
    [{ userId: RUN_ID, amount: 5, note: 12 }, "bad_request"],
  ])("rejects %j with %s before reaching the service", async (body, code) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: code });
    expect(advancesService.recordAdvance).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing or non-string member, without reaching the service", async () => {
    for (const body of [{ amount: 5 }, { userId: 7, amount: 5 }]) {
      const response = await post(body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "user_not_found" });
    }
    expect(advancesService.recordAdvance).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON null", "null"],
    ["an array", "[]"],
    ["malformed JSON", "{userId"],
    ["an empty body", ""],
  ])("answers 400 bad_request for a body that is %s", async (_name, raw) => {
    const response = await recordAdvance(request("advances", { method: "POST", raw }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(advancesService.recordAdvance).not.toHaveBeenCalled();
  });

  it("surfaces the service's refusals, a missing account and a fiscal lock", async () => {
    vi.mocked(advancesService.recordAdvance).mockRejectedValue(new PayrollError("invalid_payment_account"));
    expect((await post({ userId: RUN_ID, amount: 5 })).status).toBe(400);
    vi.mocked(advancesService.recordAdvance).mockRejectedValue(new PayrollError("user_not_found", 404));
    expect((await post({ userId: RUN_ID, amount: 5 })).status).toBe(404);
    vi.mocked(advancesService.recordAdvance).mockRejectedValue(new MissingLedgerAccountError("1260"));
    const missing = await post({ userId: RUN_ID, amount: 5 });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "ledger_account_missing", code: "1260" });
    vi.mocked(advancesService.recordAdvance).mockRejectedValue(new Error("fiscal_period_locked"));
    expect((await post({ userId: RUN_ID, amount: 5 })).status).toBe(409);
    vi.mocked(advancesService.recordAdvance).mockRejectedValue(new Error("connection reset"));
    await expect(post({ userId: RUN_ID, amount: 5 })).rejects.toThrow("connection reset");
  });
});

describe("POST /api/ledger/payroll/advances/:id/void", () => {
  it("voids with the actor and the advance id only", async () => {
    const response = await voidAdvance(request(`advances/${ADVANCE_ID}/void`, { method: "POST" }), advCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ advance: { ...ADVANCE, status: "voided" } });
    expect(advancesService.voidAdvance).toHaveBeenCalledWith({ businessId: "business-1", advanceId: ADVANCE_ID, actorId: "accountant-1" });
  });

  it.each([
    ["advance_not_found", 404],
    ["already_voided", 409],
    ["advance_already_recovered", 409],
  ])("surfaces %s as %i", async (code, status) => {
    vi.mocked(advancesService.voidAdvance).mockRejectedValue(new PayrollError(code, status));
    const response = await voidAdvance(request(`advances/${ADVANCE_ID}/void`, { method: "POST" }), advCtx);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
});

describe("the payroll settings route", () => {
  it("reads the business's own settings", async () => {
    vi.mocked(service.getPayrollSettings).mockResolvedValue({ employeeInsurancePercent: 7, taxBrackets: [] } as never);
    const response = await getSettings();
    expect(await response.json()).toEqual({ settings: { employeeInsurancePercent: 7, taxBrackets: [] } });
    expect(service.getPayrollSettings).toHaveBeenCalledWith("business-1");
  });

  it("saves a settings document and returns what was stored", async () => {
    vi.mocked(service.savePayrollSettings).mockResolvedValue({ employeeInsurancePercent: 7, taxBrackets: [] } as never);
    const response = await putSettings(request("settings", { method: "PUT", body: { employeeInsurancePercent: 7 } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: { employeeInsurancePercent: 7, taxBrackets: [] } });
    expect(service.savePayrollSettings).toHaveBeenCalledWith("business-1", { employeeInsurancePercent: 7 });
  });

  it.each([
    ["JSON null — which used to save «nothing entered» over every rate", "null"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["malformed JSON", "{employee"],
    ["an empty body", ""],
  ])("refuses a body that is %s, saving nothing", async (_name, raw) => {
    const response = await putSettings(request("settings", { method: "PUT", raw }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(service.savePayrollSettings).not.toHaveBeenCalled();
  });

  it("surfaces the validator's refusal with the field that failed", async () => {
    vi.mocked(service.savePayrollSettings).mockRejectedValue(new PayrollError("invalid_percent", 400, "employeeInsurancePercent"));
    const response = await putSettings(request("settings", { method: "PUT", body: { employeeInsurancePercent: 101 } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_percent", field: "employeeInsurancePercent" });
  });
});

describe("GET /api/ledger/payroll/staff", () => {
  it("returns wages as exact text for the business only", async () => {
    const member = {
      id: "u1",
      fullName: "A",
      role: "cashier",
      monthlyWage: "30000000",
      taxableAllowance: "0",
      nonTaxableAllowance: "0",
      fixedDeduction: "0",
      advanceOutstanding: "0",
    };
    vi.mocked(service.listStaffWages).mockResolvedValue([member]);
    const response = await listStaff();
    expect(await response.json()).toEqual({ staff: [member] });
    expect(service.listStaffWages).toHaveBeenCalledWith("business-1");
  });
});
