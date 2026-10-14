import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as service from "@/lib/commission-settlement-service";
import { CommissionSettlementError } from "@/lib/commission-settlement-errors";
import { PERMISSIONS } from "@/lib/permissions";
import { POST as createRun, GET as listRuns } from "./runs/route";
import { GET as getRun } from "./runs/[id]/route";
import { GET as getLines } from "./runs/[id]/lines/route";
import { POST as calculate } from "./runs/[id]/calculate/route";
import { POST as review } from "./runs/[id]/review/route";
import { POST as approve } from "./runs/[id]/approve/route";
import { POST as reject } from "./runs/[id]/reject/route";
import { POST as voidRun } from "./runs/[id]/void/route";
import { POST as release } from "./runs/[id]/release/route";
import { POST as close } from "./runs/[id]/close/route";
import { POST as payout } from "./runs/[id]/payouts/route";
import { POST as reversePayout } from "./payouts/[id]/reverse/route";
import { GET as paymentAccounts } from "./payment-accounts/route";
import { GET as statement } from "./statement/route";
import { GET as liability } from "./liability/route";

/**
 * The commission settlement HTTP surface (issue #869). The service is mocked;
 * these drive the real handlers and pin what the routes promise: which
 * permission each one needs (and that the void accepts either of its two),
 * that a malformed body is a 400 and never a 500, that the idempotency key
 * comes from the header, that a refusal reaches the screen with its code, and
 * that exports are downloads.
 */
vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
}));
vi.mock("@/lib/commission-settlement-service", () => ({
  createCommissionRun: vi.fn(),
  listCommissionRuns: vi.fn(),
  exportCommissionRuns: vi.fn(),
  getCommissionRun: vi.fn(),
  listCommissionRunLines: vi.fn(),
  exportCommissionRunLines: vi.fn(),
  calculateCommissionRun: vi.fn(),
  reviewCommissionRun: vi.fn(),
  approveCommissionRun: vi.fn(),
  rejectCommissionRun: vi.fn(),
  voidCommissionRun: vi.fn(),
  releaseCommissionRun: vi.fn(),
  closeCommissionRun: vi.fn(),
  recordCommissionPayout: vi.fn(),
  reverseCommissionPayout: vi.fn(),
  listCommissionPaymentAccounts: vi.fn(),
  getCommissionStatement: vi.fn(),
  getCommissionLiability: vi.fn(),
}));
vi.mock("@/lib/ai-money-unit", () => ({
  resolveBusinessMoneyUnit: vi.fn(async () => "toman"),
}));

const RUN_ID = "0b9f6a52-3c1e-4c2f-9f0a-7a0a1f4f2f11";
const PAYOUT_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const EMPLOYEE_ID = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const ctx = { params: Promise.resolve({ id: RUN_ID }) };
const payoutCtx = { params: Promise.resolve({ id: PAYOUT_ID }) };
const session = { businessId: "business-1", sub: "accountant-1", role: "accountant" };
const membership = { permissions: new Set<string>([PERMISSIONS.commissionCalculate, PERMISSIONS.commissionApprove]) };

const requirePermission = vi.mocked(auth.requirePermission);
const requireAnyPermission = vi.mocked(auth.requireAnyPermission);

function allowed(): void {
  requirePermission.mockResolvedValue({ session, membership, error: null } as never);
  requireAnyPermission.mockResolvedValue({ session, membership, error: null } as never);
}

function denied(): void {
  const error = NextResponse.json({ error: "forbidden" }, { status: 403 });
  requirePermission.mockResolvedValue({ session: null, error } as never);
  requireAnyPermission.mockResolvedValue({ session: null, error } as never);
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  allowed();
});

describe("who may call the settlement routes", () => {
  it("reads runs and lines on commission.view, and refuses a member without it", async () => {
    vi.mocked(service.listCommissionRuns).mockResolvedValue({ runs: [], total: 0 });
    expect((await listRuns(get("/api/commission/runs"))).status).toBe(200);
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionView);

    denied();
    expect((await listRuns(get("/api/commission/runs"))).status).toBe(403);
  });

  it("creates a run on commission.calculate, and only that", async () => {
    vi.mocked(service.createCommissionRun).mockResolvedValue({ run: {} as never, replayed: false });
    await createRun(post("/api/commission/runs", { periodFrom: "2026-10-01", periodTo: "2026-10-09" }));
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionCalculate);
  });

  it("calculates on commission.calculate", async () => {
    vi.mocked(service.calculateCommissionRun).mockResolvedValue({} as never);
    await calculate(post(`/api/commission/runs/${RUN_ID}/calculate`, {}), ctx);
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionCalculate);
  });

  it("reviews, approves and rejects on commission.approve", async () => {
    vi.mocked(service.reviewCommissionRun).mockResolvedValue({} as never);
    vi.mocked(service.approveCommissionRun).mockResolvedValue({} as never);
    vi.mocked(service.rejectCommissionRun).mockResolvedValue({} as never);
    for (const handler of [review, approve, reject]) {
      await handler(post(`/api/commission/runs/${RUN_ID}/x`, {}), ctx);
      expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionApprove);
    }
  });

  it("voids on either calculate or approve (the service decides which, by status)", async () => {
    vi.mocked(service.voidCommissionRun).mockResolvedValue({} as never);
    await voidRun(post(`/api/commission/runs/${RUN_ID}/void`, { note: "دوره اشتباه" }), ctx);
    expect(requireAnyPermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionCalculate, PERMISSIONS.commissionApprove);
  });

  it("releases and closes on commission.payout, and pays on commission.payout", async () => {
    vi.mocked(service.releaseCommissionRun).mockResolvedValue({} as never);
    vi.mocked(service.closeCommissionRun).mockResolvedValue({} as never);
    vi.mocked(service.recordCommissionPayout).mockResolvedValue({ run: {} as never, payout: {} as never, replayed: false });
    await release(post(`/api/commission/runs/${RUN_ID}/release`, {}), ctx);
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionPayout);
    await close(post(`/api/commission/runs/${RUN_ID}/close`, {}), ctx);
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionPayout);
    await payout(post(`/api/commission/runs/${RUN_ID}/payouts`, {}, { "Idempotency-Key": "payout-key-0001" }), ctx);
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionPayout);
  });

  it("reverses a payout on commission.reverse, and the payment accounts on commission.payout", async () => {
    vi.mocked(service.reverseCommissionPayout).mockResolvedValue({ run: {} as never, reversal: {} as never, replayed: false });
    vi.mocked(service.listCommissionPaymentAccounts).mockResolvedValue([]);
    await reversePayout(post(`/api/commission/payouts/${PAYOUT_ID}/reverse`, {}), payoutCtx);
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionReverse);
    await paymentAccounts(get("/api/commission/payment-accounts"));
    expect(requirePermission).toHaveBeenLastCalledWith(PERMISSIONS.commissionPayout);
  });
});

describe("request bodies", () => {
  it("refuses a body that is not a JSON object before the service is reached", async () => {
    const res = await createRun(post("/api/commission/runs", "[1,2]"));
    expect(res.status).toBe(400);
    expect(service.createCommissionRun).not.toHaveBeenCalled();
  });

  it("refuses a malformed period with its code, and never reaches the service", async () => {
    const res = await createRun(post("/api/commission/runs", { periodFrom: "2026-02-31", periodTo: "2026-10-09" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_period" });
    expect(service.createCommissionRun).not.toHaveBeenCalled();
  });

  it("passes the Idempotency-Key header to the service, and answers a replay with 200", async () => {
    vi.mocked(service.createCommissionRun).mockResolvedValue({ run: { id: RUN_ID } as never, replayed: true });
    const res = await createRun(
      post("/api/commission/runs", { periodFrom: "2026-10-01", periodTo: "2026-10-09" }, { "Idempotency-Key": "run-key-000001" }),
    );
    expect(res.status).toBe(200);
    expect(service.createCommissionRun).toHaveBeenCalledWith(
      "business-1",
      { userId: "accountant-1", permissions: membership.permissions },
      expect.objectContaining({ periodFrom: "2026-10-01", periodTo: "2026-10-09", employeeIds: [] }),
      "run-key-000001",
    );
  });

  it("requires an Idempotency-Key for a payout, and refuses two keys that disagree", async () => {
    const body = { allocations: [{ employeeId: EMPLOYEE_ID, amount: "100" }], method: "cash" };
    const missing = await payout(post(`/api/commission/runs/${RUN_ID}/payouts`, body), ctx);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "idempotency_key_required" });

    const disagree = await payout(
      post(`/api/commission/runs/${RUN_ID}/payouts`, { ...body, idempotencyKey: "other-key-0002" }, { "Idempotency-Key": "payout-key-0001" }),
      ctx,
    );
    expect(disagree.status).toBe(400);
    expect(await disagree.json()).toMatchObject({ error: "idempotency_key_invalid" });
    expect(service.recordCommissionPayout).not.toHaveBeenCalled();
  });

  it("parses allocations into integers before paying, and passes the resolved key", async () => {
    vi.mocked(service.recordCommissionPayout).mockResolvedValue({ run: {} as never, payout: {} as never, replayed: false });
    await payout(
      post(`/api/commission/runs/${RUN_ID}/payouts`, { allocations: [{ employeeId: EMPLOYEE_ID, amount: "1500000" }], method: "bank" }, { "Idempotency-Key": "payout-key-0003" }),
      ctx,
    );
    const [, , , input, key] = vi.mocked(service.recordCommissionPayout).mock.calls[0];
    expect(input.allocations).toEqual([{ employeeId: EMPLOYEE_ID, amount: 1_500_000n }]);
    expect(input.method).toBe("bank");
    expect(key).toBe("payout-key-0003");
  });

  it("refuses a void without a reason, so nothing is voided silently", async () => {
    const res = await voidRun(post(`/api/commission/runs/${RUN_ID}/void`, {}), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "void_reason_required" });
    expect(service.voidCommissionRun).not.toHaveBeenCalled();
  });

  it("requires a member to be named for a statement", async () => {
    const res = await statement(get("/api/commission/statement"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "employee_required" });
  });
});

describe("refusals reach the screen with their code", () => {
  it("answers an overpayment with 409, the code, and the member and their outstanding", async () => {
    vi.mocked(service.recordCommissionPayout).mockRejectedValue(
      new CommissionSettlementError("allocation_exceeds_outstanding", 409, { employeeId: EMPLOYEE_ID, outstanding: "300" }),
    );
    const res = await payout(
      post(`/api/commission/runs/${RUN_ID}/payouts`, { allocations: [{ employeeId: EMPLOYEE_ID, amount: "400" }], method: "cash" }, { "Idempotency-Key": "payout-key-0004" }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "allocation_exceeds_outstanding", employeeId: EMPLOYEE_ID, outstanding: "300" });
  });

  it("answers an unexpected failure by rethrowing it, not by inventing a 4xx", async () => {
    vi.mocked(service.getCommissionRun).mockRejectedValue(new Error("connection reset"));
    await expect(getRun(get(`/api/commission/runs/${RUN_ID}`), ctx)).rejects.toThrow("connection reset");
  });

  it("returns the run's actions for the person asking, computed by the service", async () => {
    vi.mocked(service.getCommissionRun).mockResolvedValue({ id: RUN_ID, actions: ["review"] } as never);
    const res = await getRun(get(`/api/commission/runs/${RUN_ID}`), ctx);
    expect(await res.json()).toMatchObject({ run: { actions: ["review"] } });
    expect(service.getCommissionRun).toHaveBeenCalledWith("business-1", RUN_ID, membership.permissions);
  });
});

describe("downloads", () => {
  it("exports the run list as a CSV attachment with the same filter", async () => {
    vi.mocked(service.exportCommissionRuns).mockResolvedValue([]);
    const res = await listRuns(get("/api/commission/runs?format=csv&status=approved"));
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(service.exportCommissionRuns).toHaveBeenCalledWith("business-1", "approved");
  });

  it("exports a run's lines for one member as CSV", async () => {
    vi.mocked(service.exportCommissionRunLines).mockResolvedValue([]);
    const res = await getLines(get(`/api/commission/runs/${RUN_ID}/lines?format=csv&employeeId=${EMPLOYEE_ID}`), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(service.exportCommissionRunLines).toHaveBeenCalledWith("business-1", RUN_ID, EMPLOYEE_ID);
  });

  it("answers the tie-out and the payment accounts as JSON", async () => {
    vi.mocked(service.getCommissionLiability).mockResolvedValue({ difference: "0" } as never);
    vi.mocked(service.listCommissionPaymentAccounts).mockResolvedValue([{ id: "a", code: "1100", name: "صندوق", role: "cash" }]);
    expect(await (await liability(get("/api/commission/liability"))).json()).toMatchObject({ tieOut: { difference: "0" } });
    expect(await (await paymentAccounts(get("/api/commission/payment-accounts"))).json()).toMatchObject({ accounts: [{ code: "1100" }] });
  });
});
