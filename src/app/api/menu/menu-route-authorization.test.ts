/**
 * Issue #910 — the menu API's authorization boundary, exercised as *requests*.
 *
 * The screen contract test (`menu-management-contract.test.ts`) greps the route
 * sources for `PERMISSIONS.menuEdit` / `resolveActiveLocation`; that only shows
 * the words are present. This file calls every mutating handler and reads the
 * status code back:
 *
 *   - owner and manager (the roles the menu screen is for) may mutate;
 *   - cashier, waiter, kitchen and accountant hold `menu.view` but not
 *     `menu.edit`, and must get **403** with no service call at all — a
 *     read-only member can never reach a menu write;
 *   - a member with neither permission is refused too;
 *   - the branch written to is the one the *session* resolved, never an id the
 *     request body could name, and a service-level foreign id surfaces as 404
 *     without leaking whose row it was.
 *
 * The permission decision comes from the production matrix
 * (`effectivePermissions` in permissions.ts), not from a hand-written table,
 * so a role whose capabilities change moves this test with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { effectivePermissions, PERMISSIONS, type Permission } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  role: "owner" as Role,
  location: { id: "branch-main" } as { id: string } | null,
  deniedPermission: null as string | null,
  /** A custom role with no capability at all — the matrix is a Set, not a role. */
  noPermissions: false,
  /** A custom role's exact grants; `null` means "derive them from the role". */
  customPermissions: null as Permission[] | null,
  locationCalls: 0,
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
  requirePermission: async (permission: Permission) => guard([permission]),
  requirePermissions: async (...permissions: Permission[]) => guard(permissions),
}));

/**
 * The routes read branch ownership with a `SELECT ... WHERE id=$1 AND
 * location_id=$2`; answering "one row" is the branch-owned case. The SQL is
 * the ownership check, so the stub never decides for itself.
 */
vi.mock("@/lib/db", () => ({
  query: vi.fn(async () => ({ rows: [{ id: "row-1" }], rowCount: 1 })),
}));

vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: async () => {
    mocks.locationCalls += 1;
    return mocks.location;
  },
}));

vi.mock("@/lib/menu-service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(actual)) {
    // Pure predicates stay real: mocking `isMenuReorderEntity` would let an
    // invalid entity through and quietly weaken the route's own contract.
    wrapped[key] =
      typeof value === "function" && key !== "isMenuReorderEntity" ? vi.fn() : value;
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

/**
 * The same decision `authorize()` makes for a capability, minus the database
 * lookup: identity and membership are what the real guard adds, and both are
 * irrelevant to a role/permission matrix.
 */
async function guard(permissions: Permission[]) {
  mocks.deniedPermission = null;
  const held = mocks.noPermissions
    ? new Set<Permission>()
    : mocks.customPermissions
      ? new Set<Permission>(mocks.customPermissions)
      : effectivePermissions(mocks.role, null);
  const missing = permissions.find((permission) => !held.has(permission));
  if (!missing) {
    return {
      session: { sub: "user-1", businessId: "biz-1", role: mocks.role },
      error: null,
    };
  }
  mocks.deniedPermission = missing;
  return {
    session: null,
    error: NextResponse.json(
      { error: "forbidden", code: "MISSING_PERMISSION", permission: missing },
      { status: 403 },
    ),
  };
}

import * as menuService from "@/lib/menu-service";
import * as authRoutes from "./route";
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
const OTHER_BRANCH = "66666666-6666-4666-8666-666666666666";
const ITEM = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const MODIFIER = "44444444-4444-4444-8444-444444444444";
const CATEGORY = "55555555-5555-4555-8555-555555555555";

function post(url: string, body: unknown = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(url: string, body: unknown = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "DELETE" });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Every mutating call the menu screens make, and the permission it needs. */
const MUTATIONS: {
  name: string;
  run: () => Promise<Response>;
}[] = [
  { name: "POST /api/menu/categories", run: () => categories.POST(post("/api/menu/categories", { name: "نوشیدنی" })) },
  {
    name: "PATCH /api/menu/categories/[id]",
    run: () => category.PATCH(patch(`/api/menu/categories/${CATEGORY}`, { name: "نوشیدنی" }), params(CATEGORY)),
  },
  { name: "DELETE /api/menu/categories/[id]", run: () => category.DELETE(del(`/api/menu/categories/${CATEGORY}`), params(CATEGORY)) },
  {
    name: "POST /api/menu/items",
    run: () =>
      items.POST(
        post("/api/menu/items", {
          name: "لاته",
          categoryId: CATEGORY,
          price: 100_000,
        }),
      ),
  },
  {
    name: "PATCH /api/menu/items/[id]",
    run: () => item.PATCH(patch(`/api/menu/items/${ITEM}`, { name: "لاته" }), params(ITEM)),
  },
  { name: "DELETE /api/menu/items/[id]", run: () => item.DELETE(del(`/api/menu/items/${ITEM}`), params(ITEM)) },
  {
    name: "POST /api/menu/items/[id]/price-change",
    run: () =>
      priceChange.POST(
        post(`/api/menu/items/${ITEM}/price-change`, { price: 120_000, source: "manual" }),
        params(ITEM),
      ),
  },
  {
    name: "POST /api/menu/items/[id]/suggested-price",
    run: () => suggestedPrice.POST(post(`/api/menu/items/${ITEM}/suggested-price`, {}), params(ITEM)),
  },
  {
    name: "POST /api/menu/modifier-groups",
    run: () => modifierGroups.POST(post("/api/menu/modifier-groups", { name: "افزودنی‌ها", minSelect: 0, maxSelect: 3 })),
  },
  {
    name: "PATCH /api/menu/modifier-groups/[id]",
    run: () => modifierGroup.PATCH(patch(`/api/menu/modifier-groups/${GROUP}`, { name: "افزودنی‌ها" }), params(GROUP)),
  },
  {
    name: "DELETE /api/menu/modifier-groups/[id]",
    run: () => modifierGroup.DELETE(del(`/api/menu/modifier-groups/${GROUP}`), params(GROUP)),
  },
  {
    name: "POST /api/menu/modifiers",
    run: () => modifiers.POST(post("/api/menu/modifiers", { groupId: GROUP, name: "شات اضافه", priceDelta: 20_000 })),
  },
  {
    name: "PATCH /api/menu/modifiers/[id]",
    run: () => modifier.PATCH(patch(`/api/menu/modifiers/${MODIFIER}`, { name: "شات" }), params(MODIFIER)),
  },
  {
    name: "DELETE /api/menu/modifiers/[id]",
    run: () => modifier.DELETE(del(`/api/menu/modifiers/${MODIFIER}`), params(MODIFIER)),
  },
  {
    name: "POST /api/menu/item-modifier-groups",
    run: () => itemGroups.POST(post("/api/menu/item-modifier-groups", { menuItemId: ITEM, modifierGroupId: GROUP })),
  },
  {
    name: "PATCH /api/menu/item-modifier-groups",
    run: () =>
      itemGroups.PATCH(
        patch("/api/menu/item-modifier-groups", {
          menuItemId: ITEM,
          modifierGroupId: GROUP,
          isActive: false,
        }),
      ),
  },
  {
    name: "DELETE /api/menu/item-modifier-groups",
    run: () =>
      itemGroups.DELETE(
        del(
          `/api/menu/item-modifier-groups?menuItemId=${ITEM}&modifierGroupId=${GROUP}`,
        ),
      ),
  },
  {
    name: "POST /api/menu/item-modifier-groups/reorder",
    run: () => itemGroupReorder.POST(post("/api/menu/item-modifier-groups/reorder", { menuItemId: ITEM, groupIds: [GROUP] })),
  },
  {
    name: "POST /api/menu/reorder",
    run: () => reorder.POST(post("/api/menu/reorder", { entity: "modifierGroups", ids: [GROUP] })),
  },
];

function everyServiceMock(): ReturnType<typeof vi.fn>[] {
  return Object.values(menuService).filter(
    (value): value is ReturnType<typeof vi.fn> =>
      typeof value === "function" && "mockClear" in value,
  );
}

beforeEach(() => {
  mocks.role = "owner";
  mocks.location = { id: BRANCH };
  mocks.deniedPermission = null;
  mocks.noPermissions = false;
  mocks.customPermissions = null;
  mocks.locationCalls = 0;
  vi.clearAllMocks();
  for (const fn of everyServiceMock()) fn.mockResolvedValue({ ok: true, id: ITEM });
});

describe("menu writes — the role matrix", () => {
  it.each(MUTATIONS)("$name is refused for a menu.view-only member", async ({ run }) => {
    mocks.role = "cashier";
    const response = await run();

    expect(response.status).toBe(403);
    expect(mocks.deniedPermission).toBe(PERMISSIONS.menuEdit);
    expect(await response.json()).toMatchObject({
      error: "forbidden",
      code: "MISSING_PERMISSION",
    });
    // A refusal must happen before the branch is even resolved: no service
    // call, no read of the tenant's rows.
    expect(mocks.locationCalls).toBe(0);
    for (const fn of everyServiceMock()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(["cashier", "waiter", "kitchen", "accountant"] as Role[])(
    "refuses role %s on every route (menu.view without menu.edit)",
    async (role) => {
      mocks.role = role;
      for (const mutation of MUTATIONS) {
        const response = await mutation.run();
        expect(response.status, mutation.name).toBe(403);
      }
    },
  );

  it.each(["owner", "manager"] as Role[])("allows role %s to reach the service", async (role) => {
    mocks.role = role;
    for (const mutation of MUTATIONS) {
      const response = await mutation.run();
      expect(response.status, mutation.name).toBeLessThan(400);
    }
    expect(mocks.locationCalls).toBe(MUTATIONS.length);
  });

  it("refuses a member with no menu capability at all", async () => {
    // A custom role holds exactly the permissions granted to it; a role with
    // none must reach no menu write *and* read.
    mocks.noPermissions = true;
    const response = await modifiers.POST(
      post("/api/menu/modifiers", { groupId: GROUP, name: "شات", priceDelta: 1_000 }),
    );
    expect(response.status).toBe(403);
  });
});

describe("menu writes — branch scoping", () => {
  it("always writes through the session's active branch", async () => {
    mocks.role = "manager";
    mocks.location = { id: BRANCH };

    const response = await modifierGroups.POST(
      post("/api/menu/modifier-groups", { name: "شیر", minSelect: 0, maxSelect: 1 }),
    );
    expect(response.status).toBe(200);
    expect(menuService.createModifierGroup).toHaveBeenCalledWith(
      BRANCH,
      expect.objectContaining({ name: "شیر" }),
    );
  });

  it("ignores a branch id smuggled into the request body", async () => {
    mocks.role = "owner";
    mocks.location = { id: BRANCH };

    await modifiers.POST(
      post("/api/menu/modifiers", {
        groupId: GROUP,
        name: "شات",
        priceDelta: 20_000,
        // A client naming another branch changes nothing: the route has no
        // parameter for it.
        locationId: "99999999-9999-4999-8999-999999999999",
      }),
    );

    expect(menuService.createModifier).toHaveBeenCalledWith(
      BRANCH,
      expect.objectContaining({ name: "شات" }),
    );
    expect(menuService.createModifier).not.toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      expect.anything(),
    );
  });

  it("answers a foreign id with the service's 404 and no detail", async () => {
    mocks.role = "owner";
    vi.mocked(menuService.updateModifier).mockResolvedValue({
      ok: false,
      error: "modifier_not_found",
      status: 404,
    });

    const response = await modifier.PATCH(
      patch(`/api/menu/modifiers/${MODIFIER}`, { name: "شات" }),
      params(MODIFIER),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "modifier_not_found" });
  });

  it("refuses to act when no branch is active", async () => {
    mocks.role = "owner";
    mocks.location = null;

    const response = await modifiers.POST(
      post("/api/menu/modifiers", { groupId: GROUP, name: "شات", priceDelta: 1_000 }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_location" });
    expect(menuService.createModifier).not.toHaveBeenCalled();
  });
});

describe("menu reads — view-only members keep read access", () => {
  it("serves the tree to a cashier", async () => {
    mocks.role = "cashier";
    vi.mocked(menuService.getMenuTree).mockResolvedValue({
      categories: [],
      items: [],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    } as never);

    const response = await authRoutes.GET();
    expect(response.status).toBe(200);
  });

  it("serves price history to a cashier and refuses nothing", async () => {
    mocks.role = "cashier";
    const response = await priceHistory.GET(
      new NextRequest(`http://localhost/api/menu/price-history?menuItemId=${ITEM}`),
    );
    expect(response.status).toBeLessThan(400);
  });
});

/**
 * Issue #910 — the role the audit names "view-only": a member who may look at
 * the menu and nothing more. The roles above borrow their capability from
 * `effectivePermissions`; this block pins the *custom-role* path, which is how a
 * real installation narrows a manager to read-only without changing their role.
 */
describe("menu — the view-only role", () => {
  beforeEach(() => {
    mocks.customPermissions = [PERMISSIONS.menuView];
  });

  it("reads the tree, the price history and the item editor's price suggestion", async () => {
    vi.mocked(menuService.getMenuTree).mockResolvedValue({
      categories: [],
      items: [],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    } as never);

    expect((await authRoutes.GET()).status).toBe(200);
    expect(
      (await priceHistory.GET(new NextRequest(`http://localhost/api/menu/price-history?menuItemId=${ITEM}`)))
        .status,
    ).toBeLessThan(400);
    expect(
      (
        await suggestedPrice.GET(
          new NextRequest(`http://localhost/api/menu/items/${ITEM}/suggested-price`),
          params(ITEM),
        )
      ).status,
      // …but the cost-plus suggestion is financial (recipe cost, loaded cost,
      // ledger overhead) and is gated on menu.edit AND ledger.view: a
      // view-only member must not read the cost structure of the menu.
    ).toBe(403);
  });

  it("reaches no write, on any route, and no service is called", async () => {
    for (const mutation of MUTATIONS) {
      const response = await mutation.run();
      expect(response.status, mutation.name).toBe(403);
    }
    for (const fn of everyServiceMock()) expect(fn).not.toHaveBeenCalled();
    expect(mocks.locationCalls).toBe(0);
  });
});

/**
 * Issue #910 — "check the scope and permissions of all group, modifier,
 * attachment and reorder APIs". The reorder routes are the two that take a
 * whole ordered id list from the client, so they are the ones where a smuggled
 * branch id or a stale list could do damage: both are asserted here at the
 * status-code level the screens see.
 */
describe("reorder APIs — scope and refusal mapping", () => {
  it("reorders through the session's branch and never the body's", async () => {
    mocks.role = "manager";
    mocks.location = { id: BRANCH };

    const response = await reorder.POST(
      post("/api/menu/reorder", {
        entity: "modifierGroups",
        ids: [GROUP],
        locationId: OTHER_BRANCH,
        businessId: "88888888-8888-4888-8888-888888888888",
      }),
    );

    expect(response.status).toBe(200);
    expect(menuService.reorderMenuCollection).toHaveBeenCalledWith(BRANCH, "modifierGroups", [GROUP]);
  });

  it("reports a stale item-group list as reorder_mismatch, not as success", async () => {
    mocks.role = "manager";
    vi.mocked(menuService.reorderItemModifierGroups).mockResolvedValue({
      ok: false,
      error: "reorder_mismatch",
      status: 400,
    });

    const response = await itemGroupReorder.POST(
      post("/api/menu/item-modifier-groups/reorder", { menuItemId: ITEM, groupIds: [GROUP] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "reorder_mismatch" });
    expect(menuService.reorderItemModifierGroups).toHaveBeenCalledWith(BRANCH, ITEM, [GROUP]);
  });

  it("answers a foreign item with 404 and no detail", async () => {
    mocks.role = "owner";
    vi.mocked(menuService.reorderItemModifierGroups).mockResolvedValue({
      ok: false,
      error: "item_not_found",
      status: 404,
    });

    const response = await itemGroupReorder.POST(
      post("/api/menu/item-modifier-groups/reorder", { menuItemId: ITEM, groupIds: [GROUP] }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "item_not_found" });
  });

  it("refuses malformed reorder bodies before any service call", async () => {
    mocks.role = "owner";

    const badEntity = await reorder.POST(post("/api/menu/reorder", { entity: "items2", ids: [GROUP] }));
    expect(badEntity.status).toBe(400);

    const badIds = await reorder.POST(post("/api/menu/reorder", { entity: "items", ids: "nope" }));
    expect(badIds.status).toBe(400);

    const badItem = await itemGroupReorder.POST(
      post("/api/menu/item-modifier-groups/reorder", { menuItemId: "not-a-uuid", groupIds: [GROUP] }),
    );
    expect(badItem.status).toBe(400);

    const badGroup = await itemGroupReorder.POST(
      post("/api/menu/item-modifier-groups/reorder", { menuItemId: ITEM, groupIds: ["not-a-uuid"] }),
    );
    expect(badGroup.status).toBe(400);

    expect(menuService.reorderMenuCollection).not.toHaveBeenCalled();
    expect(menuService.reorderItemModifierGroups).not.toHaveBeenCalled();
  });

  it("caps an oversized id list instead of writing thousands of positions", async () => {
    mocks.role = "owner";
    const ids = Array.from({ length: 501 }, () => GROUP);

    const response = await itemGroupReorder.POST(
      post("/api/menu/item-modifier-groups/reorder", { menuItemId: ITEM, groupIds: ids }),
    );

    expect(response.status).toBe(400);
    expect(menuService.reorderItemModifierGroups).not.toHaveBeenCalled();
  });
});
