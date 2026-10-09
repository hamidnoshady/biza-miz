/**
 * Issue #828 — one cheque by id, the endpoint the detail view navigates with.
 *
 * What it owes:
 *   - read permission, not the manage permission (a reader may follow a link);
 *   - the session's business, never a business id from the request;
 *   - another tenant's id answers 404, which is also what a nonexistent id
 *     answers — existence is not leaked;
 *   - the related cheques travel with the answer, so the dialog does not have
 *     to find them in whatever page the register happens to be showing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as chequeService from "@/lib/cheques-service";
import { GET } from "./route";

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
  return { ...actual, getChequeDetail: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const CHEQUE_ID = "33333333-3333-4333-8333-333333333333";

function request(): NextRequest {
  return new Request(
    `http://localhost:3000/api/ledger/cheques/${CHEQUE_ID}`,
  ) as unknown as NextRequest;
}

const context = { params: Promise.resolve({ id: CHEQUE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(chequeService.getChequeDetail).mockResolvedValue({
    cheque: { id: CHEQUE_ID },
    replaces: { id: "original" },
    replacements: [{ id: "child" }],
  } as never);
});

describe("GET /api/ledger/cheques/[id]", () => {
  it("asks for ledger.view", async () => {
    await GET(request(), context);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("ledger.view");
  });

  it("reads the cheque in the session's business only", async () => {
    await GET(request(), context);
    expect(vi.mocked(chequeService.getChequeDetail)).toHaveBeenCalledWith("biz-1", CHEQUE_ID);
  });

  it("returns the cheque with the originals and replacements around it", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cheque: { id: string };
      replaces: { id: string };
      replacements: { id: string }[];
    };
    expect(body.cheque.id).toBe(CHEQUE_ID);
    expect(body.replaces.id).toBe("original");
    expect(body.replacements.map((c) => c.id)).toEqual(["child"]);
  });

  it("answers 404 for a cheque that belongs to another tenant", async () => {
    // The service scopes by business id, so a foreign row is simply not
    // found — the route must pass that through as 404 rather than 403, which
    // would confirm the id exists somewhere.
    vi.mocked(chequeService.getChequeDetail).mockRejectedValue(
      new chequeService.ChequeError("cheque_not_found", 404),
    );
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "cheque_not_found" });
  });

  it("refuses a member without ledger.view", async () => {
    const forbidden = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: forbidden,
    } as never);
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expect(vi.mocked(chequeService.getChequeDetail)).not.toHaveBeenCalled();
  });
});
