/**
 * Issue #924 F02 / code-review item 4 — every price-list writer answers 403 to
 * a caller without `inventory.adjust`, and answers it *before* touching the
 * service.
 *
 * A member whose only role is «ویرایش منو» (`menu.edit`) used to be able to
 * change shelf prices through these routes. This file pins the HTTP edge of the
 * fix for all five writers; `integration/price-lists-review.integration.test.ts`
 * proves, against Postgres, that such a member really is denied by the
 * canonical `authorize()` gate the AI/MCP writers share.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as service from "@/lib/price-lists-service";
import { POST as CREATE_LIST } from "./route";
import { PATCH as RENAME_LIST, DELETE as DELETE_LIST } from "./[id]/route";
import { PUT as SAVE_ENTRIES } from "./entries/route";
import { PUT as SAVE_STOCK } from "./stock/route";
import { POST as QUICK_UPDATE } from "./quick-update/route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, requireProductWorkspaceForApi: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/price-lists-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/price-lists-service")>();
  return {
    ...actual,
    createPriceList: vi.fn(),
    renamePriceList: vi.fn(),
    deletePriceList: vi.fn(),
    savePriceEntries: vi.fn(),
    saveStockPrices: vi.fn(),
    previewQuickUpdate: vi.fn(),
    quickUpdatePrices: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const ITEM_ID = "8f14e45f-ceea-467a-9c04-9dbb1f4f6a3c";
const LIST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** What `requirePermission` returns for a member who lacks the capability. */
const DENIED = {
  session: null,
  error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
} as never;

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const context = { params: Promise.resolve({ id: LIST_ID }) };

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;

const WRITERS: { name: string; call: Handler; body: unknown }[] = [
  {
    name: "quick-update",
    call: QUICK_UPDATE as unknown as Handler,
    body: { target: { kind: "sale" }, mode: "percent", value: 10, scope: { kind: "all" } },
  },
  {
    name: "entries",
    call: SAVE_ENTRIES as unknown as Handler,
    body: { updates: [{ priceListId: LIST_ID, itemId: ITEM_ID, price: 1000 }] },
  },
  {
    name: "stock",
    call: SAVE_STOCK as unknown as Handler,
    body: { updates: [{ itemId: ITEM_ID, kind: "sale", price: 1000 }] },
  },
  {
    name: "list create",
    call: CREATE_LIST as unknown as Handler,
    body: { name: "عمده" },
  },
  {
    name: "list rename",
    call: RENAME_LIST as unknown as Handler,
    body: { name: "همکار" },
  },
  {
    name: "list delete",
    call: DELETE_LIST as unknown as Handler,
    body: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
});

describe("price-list writers deny a menu-only member", () => {
  it.each(WRITERS)("$name answers 403 and writes nothing", async ({ call, body }) => {
    vi.mocked(auth.requirePermission).mockResolvedValue(DENIED);

    const response = await call(request(body), context);

    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
    for (const write of [
      service.createPriceList,
      service.renamePriceList,
      service.deletePriceList,
      service.savePriceEntries,
      service.saveStockPrices,
      service.quickUpdatePrices,
      service.previewQuickUpdate,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("still writes for a caller that holds inventory.adjust", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
    vi.mocked(service.savePriceEntries).mockResolvedValue({ touched: 1, conflicts: [] });

    const response = await SAVE_ENTRIES(
      request({ updates: [{ priceListId: LIST_ID, itemId: ITEM_ID, price: 1000 }] }),
    );

    expect(response.status).toBe(200);
    expect(service.savePriceEntries).toHaveBeenCalledWith(
      [{ priceListId: LIST_ID, itemId: ITEM_ID, price: 1000 }],
      { locationId: "loc-1", businessId: "biz-1", userId: "user-1" },
    );
  });
});
