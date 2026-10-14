import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as reportsService from "@/lib/reports-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (h: (...args: unknown[]) => Promise<Response>) => h,
  };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return { ...actual, getAccountDrillDown: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function getRequest(qs = "") {
  return {
    url: `http://localhost:3000/api/reports/drill-down${qs}`,
    nextUrl: new URL(`http://localhost:3000/api/reports/drill-down${qs}`),
  } as unknown as NextRequest;
}

const PAGE = { lines: [], totals: { debit: "0", credit: "0", signedBalance: "0" }, totalLines: 0, hasMore: false, nextOffset: null };

/**
 * Answers the route's two questions separately: the primary read guard and
 * the elevated `reports.business_wide` check.
 */
function grantPermissions(have: { reportsView?: boolean; ledgerView?: boolean; businessWide?: boolean }) {
  const ok = { session: SESSION, error: null } as never;
  const denied = (code: string) =>
    ({ session: null, error: NextResponse.json({ error: code }, { status: 403 }) }) as never;
  vi.mocked(auth.requirePermission).mockImplementation(async (permission) => {
    if (permission === "reports.view") return have.reportsView ? ok : denied("forbidden");
    if (permission === "ledger.view") return have.ledgerView ? ok : denied("forbidden");
    if (permission === "reports.business_wide") return have.businessWide ? ok : denied("forbidden");
    return denied("forbidden");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  grantPermissions({ reportsView: true });
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-b" } as never);
  vi.mocked(reportsService.getAccountDrillDown).mockResolvedValue(PAGE as never);
});

describe("GET /api/reports/drill-down", () => {
  it("guards on reports.view and scopes the postings to the caller's resolved branch", async () => {
    await GET(getRequest("?accountCode=4000"));
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
    expect(reportsService.getAccountDrillDown).toHaveBeenCalledWith(
      "biz-1",
      "4000",
      expect.objectContaining({ locationId: "loc-b" }),
    );
  });

  it("treats an absent scope as branch — the safe default, unchanged from before", async () => {
    await GET(getRequest("?accountCode=4000"));
    expect(reportsService.getAccountDrillDown).toHaveBeenCalledWith(
      "biz-1",
      "4000",
      expect.objectContaining({ locationId: "loc-b" }),
    );
  });

  it("honours an explicit branch scope", async () => {
    const response = await GET(getRequest("?accountCode=4000&scope=branch"));
    expect(response.status).toBe(200);
    expect(reportsService.getAccountDrillDown).toHaveBeenCalledWith(
      "biz-1",
      "4000",
      expect.objectContaining({ locationId: "loc-b" }),
    );
  });

  it("refuses a business-wide drill-down for a member without the capability (issue #819)", async () => {
    grantPermissions({ reportsView: true, businessWide: false });
    const response = await GET(getRequest("?accountCode=4000&scope=business-wide"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "business_wide_forbidden" }));
    expect(reportsService.getAccountDrillDown).not.toHaveBeenCalled();
  });

  it("keeps a consolidated statement's drill-down consolidated for an authorized member", async () => {
    // Codex review, #819: a P&L read business-wide must drill into the same
    // consolidated postings — not one branch's slice, which could never
    // reconcile to the figure on screen.
    grantPermissions({ reportsView: true, businessWide: true });
    const response = await GET(getRequest("?accountCode=4000&scope=business-wide"));
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission)).toHaveBeenCalledWith("reports.business_wide");
    expect(reportsService.getAccountDrillDown).toHaveBeenCalledWith(
      "biz-1",
      "4000",
      expect.objectContaining({ locationId: undefined }),
    );
  });

  it("needs no branch assignment for an authorized business-wide drill-down", async () => {
    // The elevated path is independent of the member's active location, like
    // every other consolidated standard report.
    grantPermissions({ reportsView: true, businessWide: true });
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET(getRequest("?accountCode=4000&scope=business-wide"));
    expect(response.status).toBe(200);
    expect(setupState.resolveActiveLocation).not.toHaveBeenCalled();
  });

  it("refuses instead of widening when a branch-scoped member has no accessible branch", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET(getRequest("?accountCode=4000"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "no_accessible_branch" }));
    expect(reportsService.getAccountDrillDown).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized scope value rather than defaulting", async () => {
    const response = await GET(getRequest("?accountCode=4000&scope=everything"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "invalid_scope" }));
    expect(reportsService.getAccountDrillDown).not.toHaveBeenCalled();
  });

  it("keeps the trial-balance overlay whole-ledger under ledger.view", async () => {
    grantPermissions({ reportsView: false, ledgerView: true });
    const response = await GET(getRequest("?accountCode=4000&permissionScope=ledger"));
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("ledger.view");
    expect(reportsService.getAccountDrillDown).toHaveBeenCalledWith(
      "biz-1",
      "4000",
      expect.objectContaining({ locationId: undefined }),
    );
  });
});
