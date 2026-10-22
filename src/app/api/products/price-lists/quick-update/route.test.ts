/**
 * Issue #924 F03 — the quick-update route's scope contract, at the HTTP edge.
 *
 * The service-level decision table is unit-tested (`src/lib/price-lists.test.ts`)
 * and the SQL is integration-tested against Postgres; this file pins what the
 * route itself must never allow, because it is the only place a malformed
 * client payload can be widened into a branch-wide price change:
 *
 *   - a body with no `scope` and no `itemIds` is rejected (it used to mean
 *     "all items" — the failure this issue reports);
 *   - `itemIds: "..."` (not an array) is rejected;
 *   - a selected scope with bad / duplicate / empty ids is rejected;
 *   - preview and apply return the documented shapes, including `changed: 0`
 *     carrying an explanation instead of a bare success;
 *   - the route demands `inventory.adjust`, not a menu permission.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as service from "@/lib/price-lists-service";
import { MAX_AMOUNT } from "@/lib/price-lists-service";
import { POST } from "./route";

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
  return { ...actual, previewQuickUpdate: vi.fn(), quickUpdatePrices: vi.fn() };
});

const LIST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ITEM_ID = "8f14e45f-ceea-467a-9c04-9dbb1f4f6a3c";

const SESSION = { businessId: "biz-1", sub: "user-1" };

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** The exported handler is wrapped by `withTenantScope`; tests call it directly. */
const handler = POST as unknown as (req: NextRequest) => Promise<Response>;

async function call(body: unknown) {
  const response = await handler(request(body));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(service.quickUpdatePrices).mockResolvedValue({ changed: 2, skipped: 1 });
  vi.mocked(service.previewQuickUpdate).mockResolvedValue({
    affectedCount: 7,
    skippedCount: 3,
    sample: [{ itemId: ITEM_ID, itemName: "کرم", oldPrice: 100_000, newPrice: 110_000, willChange: true }],
    totalBefore: 700_000,
    totalAfter: 770_000,
  });
});

describe("POST /api/products/price-lists/quick-update — scope (F03)", () => {
  it("requires inventory.adjust, not a menu permission", async () => {
    await call({ target: { kind: "sale" }, mode: "percent", value: 10, scope: { kind: "all" } });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
  });

  it("rejects a body that names neither scope nor itemIds instead of widening to all", async () => {
    const { status, body } = await call({ target: { kind: "sale" }, mode: "percent", value: 10 });
    expect(status).toBe(400);
    expect(body.error).toBe("missing_scope");
    expect(service.quickUpdatePrices).not.toHaveBeenCalled();
    expect(service.previewQuickUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-array itemIds payload", async () => {
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      itemIds: ITEM_ID,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_itemIds_not_array");
    expect(service.quickUpdatePrices).not.toHaveBeenCalled();
  });

  it("rejects an empty selected scope", async () => {
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      scope: { kind: "selected", itemIds: [] },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("selected_scope_requires_ids");
  });

  it("rejects malformed and duplicate selected ids", async () => {
    const bad = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      scope: { kind: "selected", itemIds: ["not-a-uuid"] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_item_id");

    const duplicate = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      scope: { kind: "selected", itemIds: [ITEM_ID, ITEM_ID] },
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toBe("duplicate_item_id");
  });

  it("passes an explicit all scope through as an empty item list", async () => {
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      scope: { kind: "all" },
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, changed: 2, skipped: 1 });
    expect(service.quickUpdatePrices).toHaveBeenCalledWith(
      expect.objectContaining({ itemIds: [], locationId: "loc-1", businessId: "biz-1" }),
    );
  });

  it("passes a validated selected scope through unchanged", async () => {
    const { status } = await call({
      target: { kind: "list", priceListId: LIST_ID },
      mode: "amount",
      value: 5_000,
      scope: { kind: "selected", itemIds: [ITEM_ID] },
    });
    expect(status).toBe(200);
    expect(service.quickUpdatePrices).toHaveBeenCalledWith(
      expect.objectContaining({
        itemIds: [ITEM_ID],
        target: { kind: "list", priceListId: LIST_ID },
        mode: "amount",
        value: 5_000,
        source: "bulk",
      }),
    );
  });

  it("rejects an invalid list id before touching the service", async () => {
    const { status, body } = await call({
      target: { kind: "list", priceListId: "nope" },
      mode: "percent",
      value: 10,
      scope: { kind: "all" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_price_list_id");
  });

  it("says why nothing moved instead of reporting a bare success", async () => {
    vi.mocked(service.quickUpdatePrices).mockResolvedValue({ changed: 0, skipped: 4 });
    const refused = await call({
      target: { kind: "purchase" },
      mode: "percent",
      value: 10,
      scope: { kind: "all" },
    });
    expect(refused.body).toMatchObject({ ok: true, changed: 0, skipped: 4, previewNote: "all_rows_skipped" });

    vi.mocked(service.quickUpdatePrices).mockResolvedValue({ changed: 0, skipped: 0 });
    const empty = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 0,
      scope: { kind: "all" },
    });
    expect(empty.body.previewNote).toBe("no_rows_changed");
  });
});

describe("POST /api/products/price-lists/quick-update — preview (F11)", () => {
  it("returns whole-scope counts and totals in the shape the matrix reads", async () => {
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      preview: true,
      scope: { kind: "all" },
    });
    expect(status).toBe(200);
    expect(body.preview).toMatchObject({
      count: 7,
      affectedCount: 7,
      skippedCount: 3,
      totalBefore: 700_000,
      totalAfter: 770_000,
    });
    // The sample keeps the service's extra fields; the matrix only reads old/new.
    expect((body.preview as { sample: unknown[] }).sample).toEqual([
      expect.objectContaining({ itemId: ITEM_ID, oldPrice: 100_000, newPrice: 110_000 }),
    ]);
    // A preview must never write.
    expect(service.quickUpdatePrices).not.toHaveBeenCalled();
  });

  it("maps a selected scope outside this branch to a 400, not a write", async () => {
    vi.mocked(service.previewQuickUpdate).mockRejectedValue(new Error("scope_items_not_in_branch"));
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      preview: true,
      scope: { kind: "selected", itemIds: [ITEM_ID] },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("scope_items_not_in_branch");
    expect(service.quickUpdatePrices).not.toHaveBeenCalled();
  });

  it("groups one operation's audit rows under a single batch id", async () => {
    const { body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      scope: { kind: "all" },
    });
    const [input] = vi.mocked(service.quickUpdatePrices).mock.calls[0]!;
    expect(input.batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The caller gets it back, so support can cite the exact event.
    expect(body.batchId).toBe(input.batchId);
  });

  it("maps a foreign-branch selection on the apply path to a 400, not a 500", async () => {
    vi.mocked(service.quickUpdatePrices).mockRejectedValue(new Error("scope_items_not_in_branch"));
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: 10,
      scope: { kind: "selected", itemIds: [ITEM_ID] },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("scope_items_not_in_branch");
  });

  it("rejects an out-of-range percentage before previewing", async () => {
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "percent",
      value: -500,
      preview: true,
      scope: { kind: "all" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_quick_update_value");
    expect(service.previewQuickUpdate).not.toHaveBeenCalled();
  });

  it("rejects an amount the price columns could not hold, before previewing", async () => {
    // Previously this reached the service and came back as `changed: 0`, so the
    // screen said «هیچ قیمتی تغییر نکرد» for a value it had actually refused.
    const { status, body } = await call({
      target: { kind: "sale" },
      mode: "amount",
      value: MAX_AMOUNT + 1,
      preview: true,
      scope: { kind: "all" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_quick_update_value");
    expect(service.previewQuickUpdate).not.toHaveBeenCalled();
    expect(service.quickUpdatePrices).not.toHaveBeenCalled();
  });
});
