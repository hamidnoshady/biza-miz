/**
 * Issue #828 — the cheque register's HTTP contract.
 *
 * The two routes have different doors on purpose: reading the register is
 * `ledger.view`, and every write is `finance.cheques.manage`. A read-only
 * member can therefore open the page and is refused by the server if the UI
 * ever forgets to hide a button — the UI gate is a courtesy, this is the rule.
 *
 * Also pinned here: the tenant is taken from the session and never from the
 * request, a malformed body never reaches the service, and the paging and
 * due-date parameters are validated before Postgres sees them.
 *
 * The service is DB-touching and mocked; what is asserted is the contract
 * between the HTTP layer and that service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as chequeService from "@/lib/cheques-service";
import * as setupState from "@/lib/setup-state";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/cheques-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cheques-service")>();
  return { ...actual, listCheques: vi.fn(), recordCheque: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

const EMPTY_PAGE = {
  cheques: [],
  total: 0,
  hasMore: false,
  banks: [],
  summary: {},
};

function getRequest(qs = ""): NextRequest {
  return { url: `http://localhost:3000/api/ledger/cheques${qs}` } as unknown as NextRequest;
}

function postRequest(body: string | object): NextRequest {
  return new Request("http://localhost:3000/api/ledger/cheques", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "key-1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const VALID_BODY = {
  direction: "receivable",
  serialNumber: "123456",
  bankName: "ملت",
  amount: 5_000_000,
  dueDate: "2026-03-10",
  counterpartyName: "مشتری",
  customerId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(chequeService.listCheques).mockResolvedValue(EMPTY_PAGE as never);
  vi.mocked(chequeService.recordCheque).mockResolvedValue({ id: "cheque-1" } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
});

describe("GET /api/ledger/cheques — the read door", () => {
  it("asks for ledger.view", async () => {
    await GET(getRequest());
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("ledger.view");
  });

  it("returns the guard's refusal without reading the register", async () => {
    const forbidden = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: forbidden } as never);
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(chequeService.listCheques).not.toHaveBeenCalled();
  });

  it("scopes to the session's business, whatever the query string claims", async () => {
    await GET(getRequest("?businessId=someone-else"));
    expect(vi.mocked(chequeService.listCheques).mock.calls[0][0]).toBe("biz-1");
  });

  it("passes the register's filters through, including the due-date window", async () => {
    await GET(
      getRequest(
        "?direction=payable&status=returned_unresolved&bank=%D9%85%D9%84%D8%AA&q=123&sort=amount_desc&limit=25&cursor=abc123&dueFrom=2026-01-01&dueTo=2026-02-01&locationId=loc-9",
      ),
    );
    expect(vi.mocked(chequeService.listCheques).mock.calls[0][1]).toMatchObject({
      direction: "payable",
      status: "returned_unresolved",
      bankName: "ملت",
      q: "123",
      sort: "amount_desc",
      limit: 25,
      cursor: "abc123",
      dueFrom: "2026-01-01",
      dueTo: "2026-02-01",
      locationId: "loc-9",
    });
  });

  it("refuses an unusable page window before the service sees it", async () => {
    // `offset` is retired: a stale client is refused by name, not answered
    // with page one again.
    for (const qs of ["?limit=0", "?limit=abc", "?offset=0", "?offset=50"]) {
      const response = await GET(getRequest(qs));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    }
    expect(chequeService.listCheques).not.toHaveBeenCalled();
  });

  it("names an invalid direction rather than guessing one", async () => {
    const response = await GET(getRequest("?direction=sideways"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_direction" });
  });

  it("translates a service refusal into its own status", async () => {
    vi.mocked(chequeService.listCheques).mockRejectedValue(
      new chequeService.ChequeError("invalid_due_range"),
    );
    const response = await GET(getRequest("?dueFrom=2026-05-01&dueTo=2026-01-01"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_due_range" });
  });
});

describe("POST /api/ledger/cheques — the write door", () => {
  it("asks for finance.cheques_manage, not ledger.view", async () => {
    await POST(postRequest(VALID_BODY));
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("finance.cheques_manage");
  });

  it("refuses a read-only member without registering anything", async () => {
    const forbidden = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: forbidden } as never);
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(403);
    expect(chequeService.recordCheque).not.toHaveBeenCalled();
  });

  it("refuses malformed JSON instead of registering with defaults", async () => {
    const response = await POST(postRequest('{"amount": '));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(chequeService.recordCheque).not.toHaveBeenCalled();
  });

  it("carries the retry key, the replacement link and the unattributed exception", async () => {
    await POST(
      postRequest({
        ...VALID_BODY,
        allowUnattributed: true,
        replacesChequeId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(vi.mocked(chequeService.recordCheque).mock.calls[0][0]).toMatchObject({
      businessId: "biz-1",
      locationId: "loc-1",
      idempotencyKey: "key-1",
      allowUnattributed: true,
      replacesChequeId: "22222222-2222-4222-8222-222222222222",
      createdBy: "user-1",
    });
  });

  it("reports a same-key-different-payload retry as a conflict", async () => {
    vi.mocked(chequeService.recordCheque).mockRejectedValue(
      new chequeService.ChequeError("idempotency_key_conflict", 409),
    );
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "idempotency_key_conflict" });
  });

  it("reports an unrestored replacement as a conflict the UI can explain", async () => {
    vi.mocked(chequeService.recordCheque).mockRejectedValue(
      new chequeService.ChequeError("replaced_cheque_not_restored", 409),
    );
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "replaced_cheque_not_restored" });
  });
});
