import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #911 — the `/api/menu` contract on the «no active branch» path.
 *
 * The short-circuit answered four collections and omitted the fifth,
 * `itemModifierGroups`. `toRestaurantMenu` maps all five, so loading the menu
 * management screen without a branch threw inside the client's payload
 * conversion instead of showing the branch-selection empty state.
 *
 * The assertion is not «the key is present» — it is «the payload converts»,
 * because that is the actual contract a client depends on.
 */
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as menuService from "@/lib/menu-service";
import { toRestaurantMenu } from "@/lib/restaurant-menu";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/menu-service", () => ({ getMenuTree: vi.fn() }));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(menuService.getMenuTree).mockResolvedValue({
    categories: [],
    items: [],
    modifierGroups: [],
    modifiers: [],
    itemModifierGroups: [],
  } as never);
});

describe("GET /api/menu", () => {
  it("answers the full menu shape when there is no active branch", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET();
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(Object.keys(payload).sort()).toEqual([
      "categories",
      "itemModifierGroups",
      "items",
      "modifierGroups",
      "modifiers",
    ]);
    // The contract that actually matters: the client's converter must read it.
    expect(() => toRestaurantMenu(payload)).not.toThrow();
    expect(toRestaurantMenu(payload)).toEqual({
      categories: [],
      items: [],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    });
  });

  it("passes a populated tree through unchanged", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
    vi.mocked(menuService.getMenuTree).mockResolvedValue({
      categories: [{ id: "c1", name: "نوشیدنی", tax_rate: "0", sort_order: 0, is_active: true }],
      items: [
        {
          id: "i1",
          category_id: "c1",
          name: "لاته",
          description: null,
          sku: null,
          price: "120000",
          image_url: null,
          image_media_id: null,
          sort_order: 0,
          is_active: true,
          target_margin_percent: null,
        },
      ],
      modifierGroups: [],
      modifiers: [],
      itemModifierGroups: [],
    } as never);

    const payload = await (await GET()).json();
    const menu = toRestaurantMenu(payload);
    expect(menu.items).toEqual([
      expect.objectContaining({ id: "i1", name: "لاته", price: 120_000, isActive: true }),
    ]);
  });

  it("tolerates a legacy payload with no add-on attachments at all", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
    vi.mocked(menuService.getMenuTree).mockResolvedValue({
      categories: [],
      items: [],
      modifierGroups: [],
      modifiers: [],
    } as never);

    const payload = await (await GET()).json();
    // A cached or older server's payload: «no attachments», not a thrown map.
    expect(() => toRestaurantMenu(payload)).not.toThrow();
    expect(toRestaurantMenu(payload).itemModifierGroups).toEqual([]);
  });
});
