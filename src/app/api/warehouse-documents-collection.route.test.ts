/**
 * The collection register routes, tested **at the HTTP handler**, not at the
 * service they call (#923 P0).
 *
 * The branch rule used to be provable only one layer down: the integration
 * suite drove `listRetailWarehouseDocuments` / `listWarehouseDocuments` with a
 * permitted-id set it computed itself. That leaves the route — the only thing a
 * client can actually reach — untested: a route that forgot to call
 * `actionableLocationIds`, or that passed the request's `locationId` straight
 * through, would still pass those tests while leaking every branch.
 *
 * These tests therefore mock the membership layer and the lister, and assert on
 * what the handler does:
 *
 *   * a `locationId` the member may not act in is refused with the canonical
 *     403 **before** the lister runs;
 *   * no `locationId` means the server-resolved permitted set — never
 *     tenant-wide, and an empty set stays empty;
 *   * pagination is keyset-based (`hasMore` / `nextCursor`) and the page is cut
 *     at `limit`;
 *   * every filter reaches the lister;
 *   * `?format=csv` / `?format=xlsx` answer a file of the *complete filtered*
 *     register, from the same authorized branch set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as authorizeModule from "@/lib/authorize";
import * as retailService from "@/lib/retail-warehouse-document-service";
import * as fnbService from "@/lib/warehouse-document-service";
import * as settings from "@/lib/settings";
import { PERMISSIONS } from "@/lib/permissions";
import { GET as retailList } from "@/app/api/stock/warehouse-documents/route";
import { GET as fnbList } from "@/app/api/inventory/warehouse-documents/route";

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
  return {
    ...actual,
    query: vi.fn(async () => ({ rows: [] })),
    getPool: () => ({ connect: async () => ({ query: vi.fn(), release: vi.fn() }) }),
  };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return {
    ...actual,
    authorize: vi.fn(),
    actionableLocationIds: vi.fn(),
    denialResponse: vi.fn((denied: { status?: number; code?: string }) =>
      NextResponse.json(
        { error: "forbidden", code: denied.code ?? "LOCATION_FORBIDDEN" },
        { status: denied.status ?? 403 },
      ),
    ),
  };
});

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, getSetting: vi.fn(async () => ({ currencyDisplay: "toman" })) };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const USER_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12";
const LOCATION_A = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const LOCATION_B = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

const SESSION = { businessId: BUSINESS_ID, sub: USER_ID, role: "manager" };
const MEMBERSHIP = { permissions: new Set([PERMISSIONS.inventoryView]) };

function request(url: string) {
  return { url, nextUrl: new URL(url) } as unknown as NextRequest;
}

function row(id: string, index: number) {
  return {
    id,
    kind: "receipt",
    location_id: LOCATION_A,
    location_name: "Branch A",
    voucher_number: `RCV-1405-${index}`,
    business_date: "2026-01-01",
    total_value_rial: "1000",
    sort_key: `2026-01-01T00:00:00Z|${id}`,
  };
}

let retailSpy: MockInstance<typeof retailService.listRetailWarehouseDocuments>;
let fnbSpy: MockInstance<typeof fnbService.listWarehouseDocuments>;

const families = [
  ["/api/stock/warehouse-documents (retail)", retailList, () => retailSpy],
  ["/api/inventory/warehouse-documents (F&B)", fnbList, () => fnbSpy],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    membership: MEMBERSHIP,
    error: null,
  } as never);
  vi.mocked(authorizeModule.actionableLocationIds).mockResolvedValue([LOCATION_A]);
  vi.mocked(authorizeModule.authorize).mockImplementation(async (_session, request) => {
    const locationId = (request as { locationId?: string }).locationId;
    return locationId === LOCATION_A
      ? ({ ok: true } as never)
      : ({ ok: false, code: "LOCATION_FORBIDDEN", status: 403 } as never);
  });
  vi.mocked(settings.getSetting).mockResolvedValue({ currencyDisplay: "toman" } as never);
  // Every list call returns one page of two rows plus the +1 sentinel.
  retailSpy = vi.spyOn(retailService, "listRetailWarehouseDocuments").mockResolvedValue(
    [row("r1", 1), row("r2", 2), row("r3", 3)] as never,
  );
  fnbSpy = vi.spyOn(fnbService, "listWarehouseDocuments").mockResolvedValue(
    [row("f1", 1), row("f2", 2), row("f3", 3)] as never,
  );
});

describe.each(families)("GET %s — P0 branch authorization at the route", (_name, handler, spy) => {
  it("refuses a branch the member may not act in, without listing anything", async () => {
    const response = await handler(request(`http://localhost/api/x?locationId=${LOCATION_B}`));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_B });
    expect(spy().mock.calls).toHaveLength(0);
  });

  it("scopes an unfiltered list to the server-resolved permitted set", async () => {
    vi.mocked(authorizeModule.actionableLocationIds).mockResolvedValue([LOCATION_A]);

    const response = await handler(request("http://localhost/api/x"));
    expect(response.status).toBe(200);

    const [businessId, options] = spy().mock.calls[0] as unknown as [
      string,
      { locationIds: string[] },
    ];
    expect(businessId).toBe(BUSINESS_ID);
    expect(options.locationIds).toEqual([LOCATION_A]);
    // The membership resolver — not the request — decided that.
    expect(authorizeModule.actionableLocationIds).toHaveBeenCalledWith(MEMBERSHIP);
  });

  it("never falls back to a tenant-wide listing when the member has no branch", async () => {
    vi.mocked(authorizeModule.actionableLocationIds).mockResolvedValue([]);

    await handler(request("http://localhost/api/x"));

    const [, options] = spy().mock.calls[0] as unknown as [string, { locationIds: string[] }];
    expect(options.locationIds).toEqual([]);
  });

  it("authorizes a named branch it may act in and narrows to it", async () => {
    await handler(request(`http://localhost/api/x?locationId=${LOCATION_A}`));

    const [, options] = spy().mock.calls[0] as unknown as [string, { locationIds: string[] }];
    expect(options.locationIds).toEqual([LOCATION_A]);
    expect(authorizeModule.authorize).toHaveBeenCalledWith(SESSION, { locationId: LOCATION_A });
  });

  it("pages with the keyset and cuts the page at the limit", async () => {
    const response = await handler(request("http://localhost/api/x?limit=2"));
    const body = (await response.json()) as {
      documents: unknown[];
      hasMore: boolean;
      nextCursor: string | null;
    };

    expect(body.documents).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toEqual(expect.any(String));
    const [, options] = spy().mock.calls[0] as unknown as [string, { limit: number }];
    expect(options.limit).toBe(2);
  });

  it("passes search, date range, amount band, creator, posting state and sort through", async () => {
    await handler(
      request(
        "http://localhost/api/x?search=RCV&dateFrom=2026-01-01&dateTo=2026-01-31" +
          "&amountMin=1000&amountMax=5000&createdBy=" +
          USER_ID +
          "&postingState=posted&sort=amount_desc&kind=receipt",
      ),
    );

    const [, options] = spy().mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(options).toMatchObject({
      search: "RCV",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      amountMin: "1000",
      amountMax: "5000",
      createdBy: USER_ID,
      postingState: "posted",
      sort: "amount_desc",
      kind: "receipt",
      locationIds: [LOCATION_A],
    });
  });

  it("answers 400 for an impossible date range and for an unknown kind", async () => {
    const bad = await handler(request("http://localhost/api/x?dateFrom=2026-02-01&dateTo=2026-01-01"));
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toEqual({ error: "invalid_date" });

    const kind = await handler(request("http://localhost/api/x?kind=nonsense"));
    expect(kind.status).toBe(400);
    await expect(kind.json()).resolves.toEqual({ error: "bad_request" });

    expect(spy().mock.calls).toHaveLength(0);
  });

  it("exports the complete filtered register as CSV from the authorized branch set", async () => {
    const response = await handler(request("http://localhost/api/x?format=csv"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const body = await response.text();
    expect(body.split("\n")[0]).toContain("شماره انبار");

    // The export walks the keyset itself (page size 200), from the same
    // membership-derived branch set the list uses.
    const [, options] = spy().mock.calls[0] as unknown as [string, { locationIds: string[] }];
    expect(options.locationIds).toEqual([LOCATION_A]);
  });

  it("exports XLSX with the spreadsheet content type", async () => {
    const response = await handler(request("http://localhost/api/x?format=xlsx"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("refuses an export of a branch the member may not act in", async () => {
    const response = await handler(
      request(`http://localhost/api/x?format=csv&locationId=${LOCATION_B}`),
    );

    expect(response.status).toBe(403);
    expect(spy().mock.calls).toHaveLength(0);
  });
});
