import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #911 — the attachment endpoints' untrusted input.
 *
 * PATCH read `body.menuItemId` off a value it had only *cast* to
 * `Record<string, unknown>`, so the JSON literal `null` — which `JSON.parse`
 * happily returns — reached the property access and threw. Both PATCH and
 * DELETE then compared their ids against uuid columns without checking their
 * shape. Every one of those is a client mistake that must come back as a
 * structured 400, not as a thrown cast or an invalid-input database error.
 */
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as menuService from "@/lib/menu-service";
import { DELETE, PATCH } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/menu-service", () => ({
  attachModifierGroupToItem: vi.fn(),
  detachModifierGroupFromItem: vi.fn(),
  updateItemModifierGroup: vi.fn(),
}));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const VALID_BODY = { menuItemId: ITEM_ID, modifierGroupId: GROUP_ID, sortOrder: 2 };

function patchRequest(body: unknown, raw?: string) {
  return new NextRequest("http://localhost/api/menu/item-modifier-groups", {
    method: "PATCH",
    body: raw ?? JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function deleteRequest(menuItemId: string | null, modifierGroupId: string | null) {
  const params = new URLSearchParams();
  if (menuItemId !== null) params.set("menuItemId", menuItemId);
  if (modifierGroupId !== null) params.set("modifierGroupId", modifierGroupId);
  return new NextRequest(`http://localhost/api/menu/item-modifier-groups?${params}`, {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    error: null,
  } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(menuService.updateItemModifierGroup).mockResolvedValue({ ok: true } as never);
  vi.mocked(menuService.detachModifierGroupFromItem).mockResolvedValue({ ok: true } as never);
});

describe("PATCH /api/menu/item-modifier-groups", () => {
  it("refuses a JSON body that is not an object", async () => {
    for (const body of [null, [], 7, "sortOrder", true]) {
      vi.mocked(menuService.updateItemModifierGroup).mockClear();
      const response = await PATCH(patchRequest(body) as never);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad_request" });
      expect(menuService.updateItemModifierGroup).not.toHaveBeenCalled();
    }
  });

  it("refuses malformed JSON", async () => {
    const response = await PATCH(patchRequest(null, "{oops") as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "bad_request" });
  });

  it("reports missing ids as missing_fields, not as a crash", async () => {
    for (const body of [{ modifierGroupId: GROUP_ID }, { menuItemId: ITEM_ID }, {}]) {
      const response = await PATCH(patchRequest(body) as never);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "missing_fields" });
    }
  });

  it("refuses ids that are not uuids", async () => {
    for (const body of [
      { ...VALID_BODY, menuItemId: "not-a-uuid" },
      { ...VALID_BODY, modifierGroupId: "ط" },
      { menuItemId: 12, modifierGroupId: GROUP_ID, sortOrder: 1 },
    ]) {
      vi.mocked(menuService.updateItemModifierGroup).mockClear();
      const response = await PATCH(patchRequest(body) as never);
      expect(response.status).toBe(400);
      // A service call here would put the raw string into a uuid column.
      expect(menuService.updateItemModifierGroup).not.toHaveBeenCalled();
    }
  });

  it("patches a valid attachment", async () => {
    const response = await PATCH(patchRequest(VALID_BODY) as never);
    expect(response.status).toBe(200);
    expect(menuService.updateItemModifierGroup).toHaveBeenCalledWith(
      "loc-1",
      ITEM_ID,
      GROUP_ID,
      expect.objectContaining({ sortOrder: 2 }),
    );
  });
});

describe("DELETE /api/menu/item-modifier-groups", () => {
  it("reports missing ids as missing_fields", async () => {
    const response = await DELETE(deleteRequest(null, GROUP_ID) as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "missing_fields" });
  });

  it("refuses ids that are not uuids", async () => {
    for (const [item, group] of [
      ["not-a-uuid", GROUP_ID],
      [ITEM_ID, "not-a-uuid"],
      ["", ""],
    ]) {
      vi.mocked(menuService.detachModifierGroupFromItem).mockClear();
      const response = await DELETE(deleteRequest(item, group) as never);
      expect(response.status).toBe(400);
      expect(menuService.detachModifierGroupFromItem).not.toHaveBeenCalled();
    }
  });

  it("detaches a valid pair", async () => {
    const response = await DELETE(deleteRequest(ITEM_ID, GROUP_ID) as never);
    expect(response.status).toBe(200);
    expect(menuService.detachModifierGroupFromItem).toHaveBeenCalledWith(
      "loc-1",
      ITEM_ID,
      GROUP_ID,
    );
  });
});
