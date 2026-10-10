/**
 * Tests for GET/POST /api/ledger/accounts — query parsing, body validation and
 * the hardening added in issue #824 (strict boolean parsing for isContra,
 * explicit ?all=1 vs ?all=0).
 *
 * Review item 4: an earlier version of this file mocked `withTenantScope` as
 * the identity function and always resolved `requirePermission` with a session.
 * That proves nothing about isolation — the wrapper could be missing from the
 * route and these tests would still pass. So the wrapper here is the *real*
 * one (only `cookies`/`verifySession` are stubbed), and a denial case asserts
 * the service is never reached.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as accountsService from "@/lib/accounts-service";
import { getTenantScope } from "@/lib/tenant-context";
import { signSession, SESSION_COOKIE } from "@/lib/auth-edge";
import * as db from "@/lib/db";
import { GET, POST } from "./route";

// The *real* `withTenantScope` verifies the cookie itself, and an intra-module
// call cannot be stubbed (`verifySession` inside auth.ts is not the mocked
// export). So the token is genuine: a real session signed with a test secret.
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-signing-0000";
let sessionToken = "";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    // Keep the real `withTenantScope`; only the permission decision is stubbed.
  };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE ? { value: sessionToken } : undefined,
  })),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
  withTenant: vi.fn(),
}));

/**
 * The real `withTenantScope` also runs the entitlement/module/app gates before
 * the handler. Let them all pass so the tests below exercise the handler and
 * the tenant scope, not the plan checks (which have their own tests).
 */
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
  return {
    ...actual,
    listAccounts: vi.fn(),
    createAccount: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1", locationId: null, sub: "user-1", role: "owner" };

function getRequest(url: string) {
  return {
    url: `http://localhost${url}`,
    method: "GET",
    nextUrl: new URL(`http://localhost${url}`),
  } as unknown as NextRequest;
}

function postRequest(body: unknown) {
  return {
    json: async () => body,
    method: "POST",
    nextUrl: new URL("http://localhost/api/ledger/accounts"),
  } as unknown as NextRequest;
}

beforeAll(async () => {
  sessionToken = await signSession({
    businessId: "biz-1",
    locationId: null,
    sub: "user-1",
    role: "owner",
  } as never);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  // The real tenant wrapper's impersonation lookup (and any other incidental
  // read) gets a benign empty result by default; individual tests override.
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
});

describe("GET /api/ledger/accounts", () => {
  it("includes archived accounts only on ?all=1 (issue #824 §11)", async () => {
    vi.mocked(accountsService.listAccounts).mockResolvedValue([]);

    // no param → active-only flat list
    await GET(getRequest("/api/ledger/accounts"));
    expect(accountsService.listAccounts).not.toHaveBeenCalled();

    // ?all=0 → active-only flat list (NOT the management list)
    await GET(getRequest("/api/ledger/accounts?all=0"));
    expect(accountsService.listAccounts).not.toHaveBeenCalled();

    // ?all=false → active-only flat list
    await GET(getRequest("/api/ledger/accounts?all=false"));
    expect(accountsService.listAccounts).not.toHaveBeenCalled();

    // ?all=1 → management list via listAccounts({all:true})
    await GET(getRequest("/api/ledger/accounts?all=1"));
    expect(accountsService.listAccounts).toHaveBeenCalledWith("biz-1", { all: true });
    expect(accountsService.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("scopes the request to the session's business (real tenant wrapper)", async () => {
    let scopeInsideHandler: ReturnType<typeof getTenantScope> | null = null;
    vi.mocked(db.query).mockImplementation(async () => {
      scopeInsideHandler = getTenantScope();
      return { rows: [] } as never;
    });

    await GET(getRequest("/api/ledger/accounts"));

    // The handler ran inside the tenant scope the wrapper installed — that is
    // what makes RLS (`app.business_id`) apply to the query.
    expect(scopeInsideHandler).toMatchObject({ kind: "business", businessId: "biz-1" });
    // …and the flat-list query is filtered by the session's business, never by
    // anything the client sent.
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("a.business_id = $1"),
      ["biz-1"],
    );
  });

  it("403s without ledger.view and never lists accounts", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: denied as never,
    } as never);
    const res = await GET(getRequest("/api/ledger/accounts?all=1"));
    expect(res.status).toBe(403);
    expect(accountsService.listAccounts).not.toHaveBeenCalled();
    expect(auth.requirePermission).toHaveBeenCalledWith("ledger.view");
  });
});

describe("POST /api/ledger/accounts", () => {
  it("rejects non-boolean isContra (issue #824 §10)", async () => {
    const res = await POST(
      postRequest({ code: "1000", name: "A", type: "asset", isContra: "false" }),
    );
    expect(res.status).toBe(400);
    expect(accountsService.createAccount).not.toHaveBeenCalled();
  });

  it("rejects isContra=0 (number) as bad_request", async () => {
    const res = await POST(postRequest({ code: "1000", name: "A", type: "asset", isContra: 0 }));
    expect(res.status).toBe(400);
  });

  it("accepts a proper boolean isContra=true/false", async () => {
    vi.mocked(accountsService.createAccount).mockResolvedValue({ id: "acc-1" } as never);
    const resTrue = await POST(postRequest({ code: "1000", name: "A", type: "asset", isContra: true }));
    expect(resTrue.status).toBe(201);
    const resFalse = await POST(postRequest({ code: "1001", name: "B", type: "asset", isContra: false }));
    expect(resFalse.status).toBe(201);
  });

  it("passes actorId from session.sub to createAccount", async () => {
    vi.mocked(accountsService.createAccount).mockResolvedValue({ id: "acc-2" } as never);
    await POST(postRequest({ code: "2000", name: "B", type: "liability" }));
    expect(accountsService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "user-1", businessId: "biz-1" }),
    );
  });

  it("rejects a non-uuid parentId", async () => {
    const res = await POST(
      postRequest({ code: "1001", name: "A", type: "asset", parentId: "not-a-uuid" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body and a non-object body without calling the service", async () => {
    const badJson = {
      json: async () => {
        throw new Error("bad json");
      },
      method: "POST",
      nextUrl: new URL("http://localhost/api/ledger/accounts"),
    } as unknown as NextRequest;
    expect((await POST(badJson)).status).toBe(400);
    expect((await POST(postRequest(null))).status).toBe(400);
    // missing required fields
    expect((await POST(postRequest({ name: "A" }))).status).toBe(400);
    // wrong types
    expect((await POST(postRequest({ code: 1000, name: "A", type: "asset" }))).status).toBe(400);
    expect((await POST(postRequest({ code: "1", name: "A", type: "asset", parentId: 7 }))).status).toBe(400);
    expect(accountsService.createAccount).not.toHaveBeenCalled();
  });

  it("403s without accounts.edit and never creates", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: denied as never,
    } as never);

    const res = await POST(postRequest({ code: "1000", name: "A", type: "asset" }));
    expect(res.status).toBe(403);
    expect(accountsService.createAccount).not.toHaveBeenCalled();
    expect(auth.requirePermission).toHaveBeenCalledWith("accounts.edit");
  });

  it("maps each service refusal to its own HTTP status and code", async () => {
    const { AccountsError } = await import("@/lib/accounts-service");
    const cases: [string, number][] = [
      ["parent_type_mismatch", 409],
      ["parent_archived", 409],
      ["parent_too_deep", 409],
      ["code_in_use", 409],
      ["parent_not_found", 404],
      ["invalid_code", 400],
      ["name_required", 400],
    ];
    for (const [code, status] of cases) {
      vi.mocked(accountsService.createAccount).mockRejectedValueOnce(
        new AccountsError(code as never, status),
      );
      const res = await POST(postRequest({ code: "1000", name: "A", type: "asset" }));
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toEqual({ error: code });
    }
  });
});
