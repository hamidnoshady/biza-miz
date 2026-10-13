/**
 * Tests for PATCH/DELETE /api/ledger/accounts/:id.
 *
 * Review item 4: the earlier version mocked `withTenantScope` away and always
 * granted the permission, so it could not show that the route is tenant-scoped
 * or that a denial stops the write. Here the wrapper is real (only `cookies`
 * is stubbed, with a genuinely signed session) and the permission decision is
 * stubbed per-test.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as accountsService from "@/lib/accounts-service";
import { getTenantScope } from "@/lib/tenant-context";
import { signSession, SESSION_COOKIE } from "@/lib/auth-edge";
import * as db from "@/lib/db";
import { DELETE, PATCH } from "./route";

process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-signing-0000";
let sessionToken = "";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn() };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === SESSION_COOKIE ? { value: sessionToken } : undefined),
  })),
}));

vi.mock("@/lib/db", () => ({ query: vi.fn(), getPool: vi.fn(), withTenant: vi.fn() }));

vi.mock("@/lib/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/features")>()),
  isFeatureEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/industry-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/industry-guard")>()),
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/app-availability-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-availability-service")>()),
  isAppAvailable: vi.fn(async () => true),
}));

vi.mock("@/lib/accounts-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounts-service")>();
  return { ...actual, updateAccount: vi.fn(), deleteAccount: vi.fn() };
});

const SESSION = { businessId: "biz-1", locationId: null, sub: "user-1", role: "owner" };
const UUID = "11111111-2222-3333-4444-555555555555";

function request(method: string, body?: unknown) {
  return {
    method,
    nextUrl: new URL(`http://localhost/api/ledger/accounts/${UUID}`),
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  } as unknown as NextRequest;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeAll(async () => {
  sessionToken = await signSession(SESSION as never);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
});

describe("PATCH /api/ledger/accounts/:id", () => {
  it("404s a non-uuid path id without touching the service", async () => {
    const res = await PATCH(request("PATCH", { name: "x" }), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "account_not_found" });
    expect(accountsService.updateAccount).not.toHaveBeenCalled();
  });

  it("400s each non-boolean flag instead of coercing it", async () => {
    for (const body of [{ isActive: "false" }, { isActive: 0 }, { isContra: "true" }, { isContra: 1 }]) {
      const res = await PATCH(request("PATCH", body), ctx(UUID));
      expect(res.status).toBe(400);
    }
    expect(accountsService.updateAccount).not.toHaveBeenCalled();
  });

  it("400s a non-uuid or non-string parentId and an empty patch", async () => {
    expect((await PATCH(request("PATCH", { parentId: "nope" }), ctx(UUID))).status).toBe(400);
    expect((await PATCH(request("PATCH", { parentId: 12 }), ctx(UUID))).status).toBe(400);
    expect((await PATCH(request("PATCH", { name: 5 }), ctx(UUID))).status).toBe(400);
    expect((await PATCH(request("PATCH", {}), ctx(UUID))).status).toBe(400);
    expect((await PATCH(request("PATCH"), ctx(UUID))).status).toBe(400); // malformed body
    expect(accountsService.updateAccount).not.toHaveBeenCalled();
  });

  it("forwards the session identity, business and the explicit reparent flag", async () => {
    vi.mocked(accountsService.updateAccount).mockResolvedValue(undefined);
    const res = await PATCH(request("PATCH", { name: "A", parentId: UUID, isContra: true }), ctx(UUID));
    expect(res.status).toBe(200);
    expect(accountsService.updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        actorId: "user-1",
        id: UUID,
        name: "A",
        parentId: UUID,
        reparent: true,
        isContra: true,
      }),
    );
  });

  it("treats parentId: null as an explicit move to the top level", async () => {
    vi.mocked(accountsService.updateAccount).mockResolvedValue(undefined);
    await PATCH(request("PATCH", { parentId: null }), ctx(UUID));
    expect(accountsService.updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: null, reparent: true }),
    );
  });

  it("does not send a parent instruction when the key is absent", async () => {
    vi.mocked(accountsService.updateAccount).mockResolvedValue(undefined);
    await PATCH(request("PATCH", { name: "A" }), ctx(UUID));
    expect(accountsService.updateAccount).toHaveBeenCalledWith(
      expect.objectContaining({ name: "A", parentId: undefined, reparent: false }),
    );
  });

  it("403s without accounts.edit and never writes", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) as never,
    } as never);

    const res = await PATCH(request("PATCH", { name: "A" }), ctx(UUID));
    expect(res.status).toBe(403);
    expect(accountsService.updateAccount).not.toHaveBeenCalled();
    expect(auth.requirePermission).toHaveBeenCalledWith("accounts.edit");
  });

  it("runs inside the session's tenant scope", async () => {
    let scope: ReturnType<typeof getTenantScope> | null = null;
    vi.mocked(accountsService.updateAccount).mockImplementation(async () => {
      scope = getTenantScope();
    });
    await PATCH(request("PATCH", { name: "A" }), ctx(UUID));
    expect(scope).toMatchObject({ kind: "business", businessId: "biz-1" });
  });

  it("maps every hierarchy refusal to its own status and code", async () => {
    const { AccountsError } = await import("@/lib/accounts-service");
    const cases: [string, number][] = [
      ["parent_type_mismatch", 409],
      ["parent_archived", 409],
      ["ancestor_archived", 409],
      ["parent_has_active_children", 409],
      ["parent_cycle", 409],
      ["parent_too_deep", 409],
      ["well_known_account", 409],
      ["account_not_found", 404],
      ["name_required", 400],
      ["bad_request", 400],
    ];
    for (const [code, status] of cases) {
      vi.mocked(accountsService.updateAccount).mockRejectedValueOnce(
        new AccountsError(code as never, status),
      );
      const res = await PATCH(request("PATCH", { name: "A" }), ctx(UUID));
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toEqual({ error: code });
    }
  });
});

describe("DELETE /api/ledger/accounts/:id", () => {
  it("404s a non-uuid path id and never deletes", async () => {
    const res = await DELETE(request("DELETE"), ctx("123"));
    expect(res.status).toBe(404);
    expect(accountsService.deleteAccount).not.toHaveBeenCalled();
  });

  it("forwards the actor from the session", async () => {
    vi.mocked(accountsService.deleteAccount).mockResolvedValue(undefined);
    const res = await DELETE(request("DELETE"), ctx(UUID));
    expect(res.status).toBe(200);
    expect(accountsService.deleteAccount).toHaveBeenCalledWith("biz-1", UUID, "user-1");
  });

  it("403s without accounts.edit and never deletes", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) as never,
    } as never);
    const res = await DELETE(request("DELETE"), ctx(UUID));
    expect(res.status).toBe(403);
    expect(accountsService.deleteAccount).not.toHaveBeenCalled();
  });

  it("passes through each delete guard's own code", async () => {
    const { AccountsError } = await import("@/lib/accounts-service");
    const cases: [string, number][] = [
      ["account_has_postings", 409],
      ["account_has_draft_postings", 409],
      ["account_has_children", 409],
      ["well_known_account", 409],
      ["account_not_found", 404],
    ];
    for (const [code, status] of cases) {
      vi.mocked(accountsService.deleteAccount).mockRejectedValueOnce(
        new AccountsError(code as never, status),
      );
      const res = await DELETE(request("DELETE"), ctx(UUID));
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toEqual({ error: code });
    }
  });
});
