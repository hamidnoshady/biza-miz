/**
 * Issue #828 — one step of a cheque's life over HTTP.
 *
 * The invariants this route owes, each of which was a real defect:
 *   - `finance.cheques_manage`, never `ledger.view`;
 *   - no branch is read from the session — the service posts to the cheque's
 *     own `location_id`, so the operator's current location is not even sent;
 *   - an empty body is ordinary, malformed JSON is `400 bad_request` and must
 *     not transition anything;
 *   - the retry key reaches the service, from the header or the body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as chequeService from "@/lib/cheques-service";
import { POST } from "./route";

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
  return { ...actual, transitionCheque: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const CHEQUE_ID = "33333333-3333-4333-8333-333333333333";

function request(body?: string, headers: Record<string, string> = {}): NextRequest {
  return new Request(`http://localhost:3000/api/ledger/cheques/${CHEQUE_ID}/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body }),
  }) as unknown as NextRequest;
}

function context(action = "clear") {
  return { params: Promise.resolve({ id: CHEQUE_ID, action }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(chequeService.transitionCheque).mockResolvedValue({ id: CHEQUE_ID } as never);
});

describe("POST /api/ledger/cheques/[id]/[action]", () => {
  it("asks for finance.cheques_manage", async () => {
    await POST(request(), context());
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("finance.cheques_manage");
  });

  it("refuses a read-only member without transitioning anything", async () => {
    const forbidden = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: forbidden } as never);
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(chequeService.transitionCheque).not.toHaveBeenCalled();
  });

  it("never sends a branch: the cheque's own location is the one that posts", async () => {
    await POST(request(JSON.stringify({ occurredOn: "2026-03-10" })), context());
    const params = vi.mocked(chequeService.transitionCheque).mock.calls[0][0];
    expect(params).toMatchObject({ businessId: "biz-1", chequeId: CHEQUE_ID, action: "clear" });
    expect(params).not.toHaveProperty("locationId");
  });

  it("treats an empty body as an ordinary action", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(vi.mocked(chequeService.transitionCheque).mock.calls[0][0].occurredOn).toBeNull();
  });

  it("refuses malformed JSON — no status change, no entry, no event", async () => {
    for (const body of ['{"occurredOn":', "{oops}", "[]", "7"]) {
      const response = await POST(request(body), context());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    }
    expect(chequeService.transitionCheque).not.toHaveBeenCalled();
  });

  it("rejects an action that is not part of a cheque's life", async () => {
    const response = await POST(request(), context("teleport"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_action" });
    expect(chequeService.transitionCheque).not.toHaveBeenCalled();
  });

  it("passes the retry key from the header, and from the body when there is no header", async () => {
    await POST(request(undefined, { "Idempotency-Key": "from-header" }), context());
    expect(vi.mocked(chequeService.transitionCheque).mock.calls[0][0].idempotencyKey).toBe(
      "from-header",
    );

    vi.mocked(chequeService.transitionCheque).mockClear();
    await POST(request(JSON.stringify({ idempotencyKey: "from-body" })), context());
    expect(vi.mocked(chequeService.transitionCheque).mock.calls[0][0].idempotencyKey).toBe(
      "from-body",
    );
  });

  it("carries the returned-cheque charge on the bounce that caused it", async () => {
    await POST(request(JSON.stringify({ feeAmount: 30_000 })), context("bounce"));
    expect(vi.mocked(chequeService.transitionCheque).mock.calls[0][0].feeAmount).toBe(30_000);
  });

  it("gives a refused transition the service's own status and code", async () => {
    vi.mocked(chequeService.transitionCheque).mockRejectedValue(
      new chequeService.ChequeError("action_before_previous_event"),
    );
    const response = await POST(request(), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "action_before_previous_event" });

    vi.mocked(chequeService.transitionCheque).mockRejectedValue(
      new chequeService.ChequeError("idempotency_key_conflict", 409),
    );
    const conflict = await POST(request(), context());
    expect(conflict.status).toBe(409);
  });
});
