/**
 * `GET /api/stock/items` — the picker must never be a branch-enumeration door.
 *
 * The route takes `?locationId`, which is a *request*: before any item is read
 * it authorizes that branch against the membership, and the query carries the
 * business boundary as well. These tests pin both halves, because either one
 * alone would still let a member restricted to branch A see branch B.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as authorizeModule from "@/lib/authorize";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return {
    ...actual,
    authorize: vi.fn(),
    denialResponse: vi.fn(
      () => NextResponse.json({ error: "forbidden" }, { status: 403 }),
    ),
  };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const USER_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12";
const LOCATION_A = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const LOCATION_B = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

const SESSION = { businessId: BUSINESS_ID, sub: USER_ID, role: "cashier" };

function getRequest(url: string) {
  return { url, nextUrl: new URL(url) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: LOCATION_A } as never);
  vi.mocked(authorizeModule.authorize).mockResolvedValue({ ok: true } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
});

describe("GET /api/stock/items branch scoping", () => {
  it("authorizes the requested branch before reading any item", async () => {
    vi.mocked(authorizeModule.authorize).mockResolvedValue({
      ok: false,
      reason: "location_not_permitted",
    } as never);

    const response = await GET(getRequest(`http://localhost/api/stock/items?locationId=${LOCATION_B}`));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_B });
    // The refusal happens before the catalogue is touched.
    expect(db.query).not.toHaveBeenCalled();
  });

  it("scopes the item query to the branch and the tenant", async () => {
    const response = await GET(getRequest(`http://localhost/api/stock/items?locationId=${LOCATION_A}`));

    expect(response.status).toBe(200);
    // `meta`/`filteredOut` ride along from the count-workflow narrowing (#921).
    await expect(response.json()).resolves.toMatchObject({ items: [] });
    expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_A });
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/l\.business_id = \$2/);
    expect(params).toEqual([LOCATION_A, BUSINESS_ID]);
  });

  it("defaults to the active branch and authorizes that one", async () => {
    await GET(getRequest("http://localhost/api/stock/items"));

    expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_A });
  });

  it("returns an empty list when there is no branch at all, without querying", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);

    const response = await GET(getRequest("http://localhost/api/stock/items"));

    await expect(response.json()).resolves.toEqual({ items: [] });
    expect(db.query).not.toHaveBeenCalled();
  });
});
