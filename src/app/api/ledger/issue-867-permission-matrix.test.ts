/**
 * Issue #867 — the permission matrix of every route the feature added.
 *
 * The capability split the two new sections build on:
 *
 *   - `ledger.view`   — reads: the sets, the register, gaps, the renumber
 *     log, summary details, the reconciliation, the export, and the import
 *     *preview* (a preview reads the chart and the lines; it never writes);
 *   - `ledger.post`   — moving a draft forward: creating and editing a set,
 *     submitting it, generating a carry-forward proposal, generating a
 *     summary voucher;
 *   - `ledger.approve`— the decisions: approve, post, reverse a set, and
 *     the privileged renumber.
 *
 * Each handler is run through the real `withTenantScope` wrapper with the
 * session and the permission guard mocked, and is pinned twice: a denied
 * permission must stop the handler before any service call, and the allowed
 * permission must be exactly the one the matrix names, with the tenant
 * flowing into the service from the session rather than from the body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

vi.hoisted(() => {
  // The route modules import their services, and the services import ./db,
  // whose getPool() refuses to build a pool without a DATABASE_URL. Nothing
  // here ever queries — the query itself is mocked — but a few modules read
  // the variable while loading, so keep a placeholder in place.
  process.env.DATABASE_URL ??= "postgres://unconfigured:unconfigured@127.0.0.1:5432/never";
});

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  verifySession: vi.fn(),
  requirePermission: vi.fn(),
  // the wrapper's centralized gates (features, modules, availability)
  query: vi.fn(),
  isAppAvailable: vi.fn(),
  isFeatureEnabled: vi.fn(),
  isModuleEnabled: vi.fn(),
}));

// The services under test — the deny case asserts none of these ran.
const serviceMocks = vi.hoisted(() => ({
  listOpeningSets: vi.fn(),
  getOpeningSet: vi.fn(),
  createOpeningSet: vi.fn(),
  updateOpeningSetLines: vi.fn(),
  submitOpeningSet: vi.fn(),
  approveOpeningSet: vi.fn(),
  postOpeningSet: vi.fn(),
  reverseOpeningSet: vi.fn(),
  reconcileCarryForwardSet: vi.fn(),
  previewOpeningImport: vi.fn(),
  generateCarryForward: vi.fn(),
  listVoucherRegister: vi.fn(),
  voucherGapReport: vi.fn(),
  renumberEntry: vi.fn(),
  listRenumberLog: vi.fn(),
  listSummaryVouchers: vi.fn(),
  generateSummaryVoucher: vi.fn(),
  getSummaryVoucher: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth-edge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-edge")>();
  return { ...actual, verifySession: mocks.verifySession };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: mocks.requirePermission };
});
// The wrapper's centralized gates must not need a database to answer.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    query: mocks.query,
    withTenant: (_businessId: string, work: () => unknown) => work(),
  };
});
vi.mock("@/lib/app-availability-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-availability-service")>();
  return { ...actual, isAppAvailable: mocks.isAppAvailable };
});
vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>();
  return { ...actual, isFeatureEnabled: mocks.isFeatureEnabled };
});
vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, isModuleEnabled: mocks.isModuleEnabled };
});
vi.mock("@/lib/opening-balances-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/opening-balances-service")>();
  return {
    ...actual,
    listOpeningSets: serviceMocks.listOpeningSets,
    getOpeningSet: serviceMocks.getOpeningSet,
    createOpeningSet: serviceMocks.createOpeningSet,
    updateOpeningSetLines: serviceMocks.updateOpeningSetLines,
    submitOpeningSet: serviceMocks.submitOpeningSet,
    approveOpeningSet: serviceMocks.approveOpeningSet,
    postOpeningSet: serviceMocks.postOpeningSet,
    reverseOpeningSet: serviceMocks.reverseOpeningSet,
    reconcileCarryForwardSet: serviceMocks.reconcileCarryForwardSet,
    previewOpeningImport: serviceMocks.previewOpeningImport,
    generateCarryForward: serviceMocks.generateCarryForward,
  };
});
vi.mock("@/lib/voucher-numbering-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voucher-numbering-service")>();
  return {
    ...actual,
    listVoucherRegister: serviceMocks.listVoucherRegister,
    voucherGapReport: serviceMocks.voucherGapReport,
    renumberEntry: serviceMocks.renumberEntry,
    listRenumberLog: serviceMocks.listRenumberLog,
    listSummaryVouchers: serviceMocks.listSummaryVouchers,
    generateSummaryVoucher: serviceMocks.generateSummaryVoucher,
    getSummaryVoucher: serviceMocks.getSummaryVoucher,
  };
});

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const SET_ID = "33333333-3333-4333-8333-333333333333";
const ENTRY_ID = "44444444-4444-4444-8444-444444444444";
const YEAR_ID = "55555555-5555-4555-8555-555555555555";
const SUMMARY_ID = "66666666-6666-4666-8666-666666666666";

const session = {
  sub: USER_ID,
  role: "owner",
  businessId: BUSINESS_ID,
  locationId: "location-1",
};

const openingSet = {
  set: {
    id: SET_ID,
    fiscalYearLabel: "1404",
    fiscalYearId: YEAR_ID,
    effectiveDate: "2025-03-21",
    status: "posted",
    source: "manual",
    carryForwardFromYearId: null,
    journalEntryId: ENTRY_ID,
    reversalEntryId: null,
    totalDebit: "0",
    totalCredit: "0",
    note: null,
    createdBy: USER_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    submittedAt: null,
    approvedAt: null,
    postedAt: null,
    reversedAt: null,
    reversedReason: null,
    createdByName: "Owner",
  },
  lines: [],
};

const summaryVoucher = {
  id: SUMMARY_ID,
  voucherNumber: "SV-1404-000001",
  label: "خلاصه فروش",
  scope: { sourceTypes: ["order"] },
  entryCount: 0,
  totalDebit: "0",
  totalCredit: "0",
  fiscalYearLabel: "1404",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdByName: "Owner",
  sources: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "tenant-session" }) });
  mocks.verifySession.mockResolvedValue(session);
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.isAppAvailable.mockResolvedValue(true);
  mocks.isFeatureEnabled.mockResolvedValue(true);
  mocks.isModuleEnabled.mockResolvedValue(true);

  // The services answer the way a quiet database would, so every handler
  // runs to its success response and the test can prove the guard ran first.
  serviceMocks.listOpeningSets.mockResolvedValue([]);
  serviceMocks.getOpeningSet.mockResolvedValue(openingSet);
  serviceMocks.createOpeningSet.mockResolvedValue({ setId: SET_ID });
  serviceMocks.updateOpeningSetLines.mockResolvedValue({});
  serviceMocks.submitOpeningSet.mockResolvedValue({});
  serviceMocks.approveOpeningSet.mockResolvedValue(undefined);
  serviceMocks.postOpeningSet.mockResolvedValue({ entryId: ENTRY_ID });
  serviceMocks.reverseOpeningSet.mockResolvedValue({ entryId: ENTRY_ID });
  serviceMocks.reconcileCarryForwardSet.mockResolvedValue({
    matched: true,
    rows: [],
    notes: [],
    totals: { expectedDebit: "0", expectedCredit: "0", actualDebit: "0", actualCredit: "0" },
  });
  serviceMocks.previewOpeningImport.mockResolvedValue({
    valid: true,
    problem: null,
    totalDebit: "0",
    totalCredit: "0",
    lineCount: 0,
    accounts: [],
  });
  serviceMocks.generateCarryForward.mockResolvedValue({
    setId: SET_ID,
    idempotent: false,
    lines: [],
    notes: [],
    balanced: true,
  });
  serviceMocks.listVoucherRegister.mockResolvedValue({ rows: [], nextCursor: null, total: 0 });
  serviceMocks.voucherGapReport.mockResolvedValue({
    documentType: "journal",
    fiscalYearLabel: "1404",
    presentCount: 0,
    maxSequenceNo: 0,
    gapCount: 0,
    missing: [],
    missingTruncated: false,
    counterMax: 0,
  });
  serviceMocks.renumberEntry.mockResolvedValue({ entryId: ENTRY_ID, voucherNumber: "MJ-1404-000001" });
  serviceMocks.listRenumberLog.mockResolvedValue([]);
  serviceMocks.listSummaryVouchers.mockResolvedValue([]);
  serviceMocks.generateSummaryVoucher.mockResolvedValue({ ...summaryVoucher, idempotent: false });
  serviceMocks.getSummaryVoucher.mockResolvedValue(summaryVoucher);
});

function request(path: string, body?: unknown): NextRequest {
  return new NextRequest(`https://tenant.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function ctxFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

interface Case {
  name: string;
  expectedPermission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
  build: () => Promise<Response>;
  /** What the handler must have asked the service for, once the guard let it in. */
  assertServiceCalls: () => void;
}

const cases: Case[] = [
  {
    name: "GET /api/ledger/opening-balances",
    expectedPermission: PERMISSIONS.ledgerView,
    // The collection GET is declared without arguments (Next still supplies
    // the request, and the wrapper consumes it for the centralized gates).
    build: async () =>
      ((await import("./opening-balances/route")).GET as unknown as (
        req: NextRequest,
      ) => Promise<Response>)(request("/api/ledger/opening-balances")),
    assertServiceCalls: () => {
      expect(serviceMocks.listOpeningSets).toHaveBeenCalledOnce();
      expect(serviceMocks.listOpeningSets).toHaveBeenCalledWith(BUSINESS_ID);
    },
  },
  {
    name: "POST /api/ledger/opening-balances",
    expectedPermission: PERMISSIONS.ledgerPost,
    build: async () =>
      (await import("./opening-balances/route")).POST(
        request("/api/ledger/opening-balances", {
          fiscalYearLabel: "1404",
          effectiveDate: "2025-03-21",
          lines: [],
        }),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.createOpeningSet).toHaveBeenCalledOnce();
      expect(serviceMocks.createOpeningSet).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, actorId: USER_ID }),
      );
    },
  },
  {
    name: "GET /api/ledger/opening-balances/[id]",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () =>
      (await import("./opening-balances/[id]/route")).GET(
        request(`/api/ledger/opening-balances/${SET_ID}`),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.getOpeningSet).toHaveBeenCalledOnce();
      expect(serviceMocks.getOpeningSet).toHaveBeenCalledWith(BUSINESS_ID, SET_ID);
    },
  },
  {
    name: "PUT /api/ledger/opening-balances/[id]",
    expectedPermission: PERMISSIONS.ledgerPost,
    build: async () =>
      (await import("./opening-balances/[id]/route")).PUT(
        request(`/api/ledger/opening-balances/${SET_ID}`, { lines: [], note: null }),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.updateOpeningSetLines).toHaveBeenCalledOnce();
      expect(serviceMocks.updateOpeningSetLines).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, setId: SET_ID, actorId: USER_ID }),
      );
    },
  },
  {
    name: "POST /api/ledger/opening-balances/[id]/submit",
    expectedPermission: PERMISSIONS.ledgerPost,
    build: async () =>
      (await import("./opening-balances/[id]/submit/route")).POST(
        request(`/api/ledger/opening-balances/${SET_ID}/submit`, {}),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.submitOpeningSet).toHaveBeenCalledOnce();
      expect(serviceMocks.submitOpeningSet).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, setId: SET_ID }),
      );
    },
  },
  {
    name: "POST /api/ledger/opening-balances/[id]/approve",
    expectedPermission: PERMISSIONS.ledgerApprove,
    build: async () =>
      (await import("./opening-balances/[id]/approve/route")).POST(
        request(`/api/ledger/opening-balances/${SET_ID}/approve`, {}),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.approveOpeningSet).toHaveBeenCalledOnce();
      expect(serviceMocks.approveOpeningSet).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, setId: SET_ID, actorId: USER_ID }),
      );
    },
  },
  {
    name: "POST /api/ledger/opening-balances/[id]/post",
    expectedPermission: PERMISSIONS.ledgerApprove,
    build: async () =>
      (await import("./opening-balances/[id]/post/route")).POST(
        request(`/api/ledger/opening-balances/${SET_ID}/post`, {}),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.postOpeningSet).toHaveBeenCalledOnce();
      expect(serviceMocks.postOpeningSet).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, setId: SET_ID, actorId: USER_ID }),
      );
    },
  },
  {
    name: "POST /api/ledger/opening-balances/[id]/reverse",
    expectedPermission: PERMISSIONS.ledgerApprove,
    build: async () =>
      (await import("./opening-balances/[id]/reverse/route")).POST(
        request(`/api/ledger/opening-balances/${SET_ID}/reverse`, { reason: "خطا در ثبت" }),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.reverseOpeningSet).toHaveBeenCalledOnce();
      expect(serviceMocks.reverseOpeningSet).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, setId: SET_ID, reason: "خطا در ثبت" }),
      );
    },
  },
  {
    name: "GET /api/ledger/opening-balances/[id]/reconciliation",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () =>
      (await import("./opening-balances/[id]/reconciliation/route")).GET(
        request(`/api/ledger/opening-balances/${SET_ID}/reconciliation`),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.reconcileCarryForwardSet).toHaveBeenCalledOnce();
      expect(serviceMocks.reconcileCarryForwardSet).toHaveBeenCalledWith(BUSINESS_ID, SET_ID);
    },
  },
  {
    name: "GET /api/ledger/opening-balances/[id]/export",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () =>
      (await import("./opening-balances/[id]/export/route")).GET(
        request(`/api/ledger/opening-balances/${SET_ID}/export?format=csv`),
        ctxFor(SET_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.getOpeningSet).toHaveBeenCalledOnce();
      expect(serviceMocks.getOpeningSet).toHaveBeenCalledWith(BUSINESS_ID, SET_ID);
    },
  },
  {
    name: "POST /api/ledger/opening-balances/import (preview only)",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () =>
      (await import("./opening-balances/import/route")).POST(
        request("/api/ledger/opening-balances/import", {
          fiscalYearLabel: "1404",
          effectiveDate: "2025-03-21",
          lines: [],
        }),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.previewOpeningImport).toHaveBeenCalledOnce();
      expect(serviceMocks.previewOpeningImport).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID }),
      );
    },
  },
  {
    name: "POST /api/ledger/opening-balances/carry-forward",
    expectedPermission: PERMISSIONS.ledgerPost,
    build: async () =>
      (await import("./opening-balances/carry-forward/route")).POST(
        request("/api/ledger/opening-balances/carry-forward", {
          fromYearId: YEAR_ID,
          toYearId: `${YEAR_ID.replace("5555", "7777")}`,
        }),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.generateCarryForward).toHaveBeenCalledOnce();
      expect(serviceMocks.generateCarryForward).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, fromYearId: YEAR_ID, actorId: USER_ID }),
      );
    },
  },
  {
    name: "GET /api/ledger/vouchers (the register)",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () => (await import("./vouchers/route")).GET(request("/api/ledger/vouchers")),
    assertServiceCalls: () => {
      expect(serviceMocks.listVoucherRegister).toHaveBeenCalledOnce();
      expect(serviceMocks.listVoucherRegister).toHaveBeenCalledWith(BUSINESS_ID, expect.anything());
    },
  },
  {
    name: "GET /api/ledger/vouchers/gaps",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () =>
      (await import("./vouchers/gaps/route")).GET(
        request("/api/ledger/vouchers/gaps?fiscalYearLabel=1404&documentType=journal"),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.voucherGapReport).toHaveBeenCalledOnce();
      expect(serviceMocks.voucherGapReport).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.objectContaining({ fiscalYearLabel: "1404", documentType: "journal" }),
      );
    },
  },
  {
    name: "POST /api/ledger/vouchers/renumber",
    expectedPermission: PERMISSIONS.ledgerApprove,
    build: async () =>
      (await import("./vouchers/renumber/route")).POST(
        request("/api/ledger/vouchers/renumber", {
          entryId: ENTRY_ID,
          newSequenceNo: 2,
          reason: "شماره اشتباه ثبت شده بود",
        }),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.renumberEntry).toHaveBeenCalledOnce();
      expect(serviceMocks.renumberEntry).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, entryId: ENTRY_ID, actorId: USER_ID }),
      );
    },
  },
  {
    name: "GET /api/ledger/vouchers/renumber-log",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () => (await import("./vouchers/renumber-log/route")).GET(request("/api/ledger/vouchers/renumber-log")),
    assertServiceCalls: () => {
      expect(serviceMocks.listRenumberLog).toHaveBeenCalledOnce();
      expect(serviceMocks.listRenumberLog).toHaveBeenCalledWith(BUSINESS_ID);
    },
  },
  {
    name: "GET /api/ledger/summary-vouchers",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () =>
      ((await import("./summary-vouchers/route")).GET as unknown as (
        req: NextRequest,
      ) => Promise<Response>)(request("/api/ledger/summary-vouchers")),
    assertServiceCalls: () => {
      expect(serviceMocks.listSummaryVouchers).toHaveBeenCalledOnce();
      expect(serviceMocks.listSummaryVouchers).toHaveBeenCalledWith(BUSINESS_ID);
    },
  },
  {
    name: "POST /api/ledger/summary-vouchers",
    expectedPermission: PERMISSIONS.ledgerPost,
    build: async () =>
      (await import("./summary-vouchers/route")).POST(
        request("/api/ledger/summary-vouchers", {
          label: "خلاصه فروش",
          scope: { sourceTypes: ["order"] },
        }),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.generateSummaryVoucher).toHaveBeenCalledOnce();
      expect(serviceMocks.generateSummaryVoucher).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, actorId: USER_ID }),
      );
    },
  },
  {
    name: "GET /api/ledger/summary-vouchers/[id]",
    expectedPermission: PERMISSIONS.ledgerView,
    build: async () =>
      (await import("./summary-vouchers/[id]/route")).GET(
        request(`/api/ledger/summary-vouchers/${SUMMARY_ID}`),
        ctxFor(SUMMARY_ID),
      ),
    assertServiceCalls: () => {
      expect(serviceMocks.getSummaryVoucher).toHaveBeenCalledOnce();
      expect(serviceMocks.getSummaryVoucher).toHaveBeenCalledWith(BUSINESS_ID, SUMMARY_ID);
    },
  },
];

describe("issue #867 — the permission matrix of every new route", () => {
  for (const c of cases) {
    it(`${c.name} refuses a member without ${c.expectedPermission} before any work happens`, async () => {
      mocks.requirePermission.mockResolvedValue({
        session: null,
        error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
      });

      const response = await c.build();

      expect(response.status).toBe(403);
      expect(mocks.requirePermission).toHaveBeenCalledWith(c.expectedPermission);
      // The guard is the first call the handler makes: no service may have run.
      for (const service of Object.values(serviceMocks)) {
        expect(service, `${(service as { name: string }).name} must not run under a 403`).not.toHaveBeenCalled();
      }
    });

    it(`${c.name} runs with ${c.expectedPermission} and scopes to the session's tenant`, async () => {
      mocks.requirePermission.mockResolvedValue({ session, error: null });

      const response = await c.build();

      expect(mocks.requirePermission).toHaveBeenCalledTimes(1);
      expect(mocks.requirePermission).toHaveBeenCalledWith(c.expectedPermission);
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      c.assertServiceCalls();
    });
  }
});
