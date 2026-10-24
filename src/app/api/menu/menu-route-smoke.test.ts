/**
 * Issue #910 — smoke tests for every menu API route.
 *
 * The audit asked for "contract/smoke tests for non-404, method, auth and
 * status behaviour" on the add-on surface. The authorization suite next door
 * (`menu-route-authorization.test.ts`) answers *who* may call each route; this
 * file checks that the routes themselves still exist and answer:
 *
 *   - every `src/app/api/menu/**\/route.ts` on disk is listed here, so adding a
 *     route without a smoke entry fails the suite instead of shipping an
 *     endpoint nobody calls;
 *   - each module exports exactly the HTTP methods it declares — a handler that
 *     was renamed, folded into a sibling route or drop-tested away is a 405
 *     for the screens that call it;
 *   - a permitted caller never gets 404/405/5xx from a well-formed request:
 *     the route is wired to its service, its body parsing and its status
 *     mapping, not merely present on disk;
 *   - an unauthenticated / unpermitted caller gets 403 before any service call.
 *
 * 404 is deliberately *not* accepted for a fresh request: "route exists but
 * answers 404" is exactly what a dead endpoint looks like to the POS.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS, type Permission } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  allowed: true,
  deniedPermission: null as string | null,
  wrapped: 0,
  serviceCalls: 0,
}));

vi.mock("@/lib/auth", () => ({
  // The real `withTenantScope` opens a tenant scope; the smoke test only needs
  // to know the handler went through it, so it counts the wrap and passes the
  // handler straight through.
  withTenantScope: (handler: (...args: never[]) => Promise<Response>) => {
    mocks.wrapped += 1;
    return handler;
  },
  requirePermission: async (permission: Permission) => {
    if (mocks.allowed) return { session: { sub: "user-1", businessId: "biz-1" }, error: null };
    mocks.deniedPermission = permission;
    return {
      session: null,
      error: NextResponse.json(
        { error: "forbidden", code: "MISSING_PERMISSION", permission },
        { status: 403 },
      ),
    };
  },
  requirePermissions: async (...permissions: Permission[]) => {
    if (mocks.allowed) return { session: { sub: "user-1", businessId: "biz-1" }, error: null };
    mocks.deniedPermission = permissions[0] ?? null;
    return {
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  },
}));

vi.mock("@/lib/db", () => ({
  /**
   * The `[id]` routes read the row back (`WHERE id = $1 AND location_id = $2`)
   * before acting — that predicate *is* the branch-ownership check, and a
   * 404 there means "not this branch's row". Answering one row is the
   * happy path this smoke test is about; foreign-id handling lives in
   * `menu-route-authorization.test.ts`.
   */
  query: vi.fn(async () => ({ rows: [{ id: "row-1" }], rowCount: 1 })),
}));

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
}));

/**
 * Every menu-service function answers "ok" so a 404 can only come from the
 * route itself (a bad URL, a missing handler, an unmapped method). The pure
 * predicates stay real: mocking them would let an invalid entity through and
 * hide the route's own validation.
 */
vi.mock("@/lib/menu-service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    wrapped[key] =
      typeof value === "function" && key !== "isMenuReorderEntity"
        ? vi.fn(async () => {
            mocks.serviceCalls += 1;
            return { ok: true, id: "22222222-2222-4222-8222-222222222222" };
          })
        : value;
  }
  return wrapped;
});

vi.mock("@/lib/menu-price-service", () => ({
  changeMenuItemPrice: vi.fn(async () => ({ ok: true })),
  listPriceHistory: vi.fn(async () => []),
  latestPriceChangesByItem: vi.fn(async () => []),
  isPriceChangeSource: () => true,
}));

vi.mock("@/lib/pricing-service", () => ({
  getSuggestedPrice: vi.fn(async () => ({ suggestedPrice: 120_000, marginPercent: 30 })),
  changeMenuItemPrice: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async () => null),
  SETTING_KEYS: { tax: "tax" },
}));

import * as root from "./route";
import * as categories from "./categories/route";
import * as category from "./categories/[id]/route";
import * as items from "./items/route";
import * as item from "./items/[id]/route";
import * as priceChange from "./items/[id]/price-change/route";
import * as suggestedPrice from "./items/[id]/suggested-price/route";
import * as modifierGroups from "./modifier-groups/route";
import * as modifierGroup from "./modifier-groups/[id]/route";
import * as modifiers from "./modifiers/route";
import * as modifier from "./modifiers/[id]/route";
import * as itemGroups from "./item-modifier-groups/route";
import * as itemGroupReorder from "./item-modifier-groups/reorder/route";
import * as reorder from "./reorder/route";
import * as priceHistory from "./price-history/route";

const BRANCH = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const MODIFIER = "44444444-4444-4444-8444-444444444444";
const CATEGORY = "55555555-5555-4555-8555-555555555555";

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function request(method: HttpMethod, url: string, body: unknown = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body) }),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

interface RouteCase {
  /** Path relative to this directory, matching the file on disk. */
  file: string;
  methods: HttpMethod[];
  call: Partial<Record<HttpMethod, () => Promise<Response>>>;
}

/**
 * Every route file under `src/app/api/menu`, the methods it must export and a
 * well-formed request for each. New endpoints belong here.
 */
const ROUTES: RouteCase[] = [
  {
    file: "route.ts",
    methods: ["GET"],
    call: { GET: () => root.GET() },
  },
  {
    file: "categories/route.ts",
    methods: ["POST"],
    call: {
      POST: () => categories.POST(request("POST", "/api/menu/categories", { name: "نوشیدنی" })),
    },
  },
  {
    file: "categories/[id]/route.ts",
    methods: ["PATCH", "DELETE"],
    call: {
      PATCH: () =>
        category.PATCH(request("PATCH", `/api/menu/categories/${CATEGORY}`, { name: "نوشیدنی" }), params(CATEGORY)),
      DELETE: () => category.DELETE(request("DELETE", `/api/menu/categories/${CATEGORY}`), params(CATEGORY)),
    },
  },
  {
    file: "items/route.ts",
    methods: ["POST"],
    call: {
      POST: () =>
        items.POST(
          request("POST", "/api/menu/items", { name: "لاته", categoryId: CATEGORY, price: 100_000 }),
        ),
    },
  },
  {
    file: "items/[id]/route.ts",
    methods: ["PATCH", "DELETE"],
    call: {
      PATCH: () => item.PATCH(request("PATCH", `/api/menu/items/${ITEM}`, { name: "لاته" }), params(ITEM)),
      DELETE: () => item.DELETE(request("DELETE", `/api/menu/items/${ITEM}`), params(ITEM)),
    },
  },
  {
    file: "items/[id]/price-change/route.ts",
    methods: ["POST"],
    call: {
      POST: () =>
        priceChange.POST(
          request("POST", `/api/menu/items/${ITEM}/price-change`, { price: 120_000, source: "manual" }),
          params(ITEM),
        ),
    },
  },
  {
    file: "items/[id]/suggested-price/route.ts",
    methods: ["GET", "POST"],
    call: {
      GET: () => suggestedPrice.GET(request("GET", `/api/menu/items/${ITEM}/suggested-price`), params(ITEM)),
      POST: () => suggestedPrice.POST(request("POST", `/api/menu/items/${ITEM}/suggested-price`), params(ITEM)),
    },
  },
  {
    file: "modifier-groups/route.ts",
    methods: ["POST"],
    call: {
      POST: () =>
        modifierGroups.POST(
          request("POST", "/api/menu/modifier-groups", { name: "افزودنی‌ها", minSelect: 0, maxSelect: 3 }),
        ),
    },
  },
  {
    file: "modifier-groups/[id]/route.ts",
    methods: ["PATCH", "DELETE"],
    call: {
      PATCH: () =>
        modifierGroup.PATCH(request("PATCH", `/api/menu/modifier-groups/${GROUP}`, { name: "افزودنی‌ها" }), params(GROUP)),
      DELETE: () => modifierGroup.DELETE(request("DELETE", `/api/menu/modifier-groups/${GROUP}`), params(GROUP)),
    },
  },
  {
    file: "modifiers/route.ts",
    methods: ["POST"],
    call: {
      POST: () =>
        modifiers.POST(
          request("POST", "/api/menu/modifiers", { groupId: GROUP, name: "شات اضافه", priceDelta: 20_000 }),
        ),
    },
  },
  {
    file: "modifiers/[id]/route.ts",
    methods: ["PATCH", "DELETE"],
    call: {
      PATCH: () => modifier.PATCH(request("PATCH", `/api/menu/modifiers/${MODIFIER}`, { name: "شات" }), params(MODIFIER)),
      DELETE: () => modifier.DELETE(request("DELETE", `/api/menu/modifiers/${MODIFIER}`), params(MODIFIER)),
    },
  },
  {
    file: "item-modifier-groups/route.ts",
    methods: ["POST", "PATCH", "DELETE"],
    call: {
      POST: () =>
        itemGroups.POST(request("POST", "/api/menu/item-modifier-groups", { menuItemId: ITEM, modifierGroupId: GROUP })),
      PATCH: () =>
        itemGroups.PATCH(
          request("PATCH", "/api/menu/item-modifier-groups", {
            menuItemId: ITEM,
            modifierGroupId: GROUP,
            isActive: false,
          }),
        ),
      DELETE: () =>
        itemGroups.DELETE(
          request("DELETE", `/api/menu/item-modifier-groups?menuItemId=${ITEM}&modifierGroupId=${GROUP}`),
        ),
    },
  },
  {
    file: "item-modifier-groups/reorder/route.ts",
    methods: ["POST"],
    call: {
      POST: () =>
        itemGroupReorder.POST(
          request("POST", "/api/menu/item-modifier-groups/reorder", { menuItemId: ITEM, groupIds: [GROUP] }),
        ),
    },
  },
  {
    file: "reorder/route.ts",
    methods: ["POST"],
    call: {
      POST: () =>
        reorder.POST(request("POST", "/api/menu/reorder", { entity: "modifierGroups", ids: [GROUP] })),
    },
  },
  {
    file: "price-history/route.ts",
    methods: ["GET"],
    call: {
      GET: () => priceHistory.GET(new NextRequest(`http://localhost/api/menu/price-history?menuItemId=${ITEM}`)),
    },
  },
];

const MODULES: Record<string, Record<string, unknown>> = {
  "route.ts": root,
  "categories/route.ts": categories,
  "categories/[id]/route.ts": category,
  "items/route.ts": items,
  "items/[id]/route.ts": item,
  "items/[id]/price-change/route.ts": priceChange,
  "items/[id]/suggested-price/route.ts": suggestedPrice,
  "modifier-groups/route.ts": modifierGroups,
  "modifier-groups/[id]/route.ts": modifierGroup,
  "modifiers/route.ts": modifiers,
  "modifiers/[id]/route.ts": modifier,
  "item-modifier-groups/route.ts": itemGroups,
  "item-modifier-groups/reorder/route.ts": itemGroupReorder,
  "reorder/route.ts": reorder,
  "price-history/route.ts": priceHistory,
};

function routeFilesOnDisk(dir = __dirname): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...routeFilesOnDisk(full));
    } else if (entry === "route.ts") {
      found.push(relative(__dirname, full).split("\\").join("/"));
    }
  }
  return found.sort();
}

function exportedMethods(module: Record<string, unknown>): string[] {
  return Object.keys(module)
    .filter((key) => (HTTP_METHODS as readonly string[]).includes(key))
    .sort();
}

beforeEach(() => {
  mocks.allowed = true;
  mocks.deniedPermission = null;
  mocks.serviceCalls = 0;
  vi.clearAllMocks();
});

describe("every menu API route is present and answers", () => {
  it("covers every route file on disk — a new endpoint cannot ship untested", () => {
    expect(ROUTES.map((route) => route.file).sort()).toEqual(routeFilesOnDisk());
  });

  it("wraps every handler in the tenant scope", () => {
    // Each route module wraps its handlers at import time, so the counter is
    // the number of exported handlers across all fifteen files.
    expect(mocks.wrapped).toBe(
      ROUTES.reduce((total, route) => total + route.methods.length, 0),
    );
  });

  it.each(ROUTES)("$file exports exactly the methods the screens call", ({ file, methods }) => {
    const module = MODULES[file];
    expect(module, `${file} is imported above`).toBeTruthy();
    expect(exportedMethods(module)).toEqual([...methods].sort());
    // Anything else exported from a route file is not an HTTP handler.
    for (const key of Object.keys(module)) {
      if ((HTTP_METHODS as readonly string[]).includes(key)) continue;
      expect(["config", "dynamic", "revalidate", "runtime"], `${file} exports ${key}`).toContain(key);
    }
  });

  it.each(ROUTES.flatMap((route) => route.methods.map((method) => ({ route, method }))))(
    "$route.file $method answers a permitted caller without 404/405/5xx",
    async ({ route, method }) => {
      const handler = route.call[method];
      expect(handler, `${method} handler declared`).toBeTruthy();
      const response = await handler!();
      expect([404, 405], `${method} on ${route.file} reached a missing route`).not.toContain(
        response.status,
      );
      expect(response.status, `${method} on ${route.file}`).toBeLessThan(500);
    },
  );

  it("refuses every route with 403 when the member lacks the permission", async () => {
    mocks.allowed = false;
    for (const route of ROUTES) {
      for (const method of route.methods) {
        const handler = route.call[method];
        const response = await handler!();
        expect(response.status, `${method} ${route.file}`).toBe(403);
        // Reads need `menu.view`, writes `menu.edit`; the point of the smoke
        // test is that a permission is consulted at all, before any service.
        expect(mocks.deniedPermission, `${method} ${route.file}`).toMatch(/^menu\./);
        expect(mocks.serviceCalls, `${method} ${route.file}`).toBe(0);
      }
    }
  });
});
