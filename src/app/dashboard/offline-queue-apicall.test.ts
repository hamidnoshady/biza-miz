// @vitest-environment jsdom

/**
 * Issue #909 item 5 behavioral test "offline" — `apiOrQueue` (the mutation
 * wrapper every section's offline-first submit path goes through) must tell
 * apart a genuine LAN drop (fetch() itself throws — nobody ever reached the
 * server) from a server-side rejection (fetch() resolves, just with
 * `ok:false` — the server *did* answer, with a real validation/conflict
 * error). Only the first is offline-queued; the second must surface to the
 * caller as a normal failure, never silently queued as if it might still
 * succeed once "reconnected".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const pendingActionsAdd = vi.fn(async (_entry: Record<string, unknown>) => undefined);
vi.mock("@/lib/offline-db", () => ({
  getOfflineDb: () => ({ pendingActions: { add: pendingActionsAdd } }),
}));

import { apiOrQueue } from "./offline-queue";

afterEach(() => {
  vi.unstubAllGlobals();
  pendingActionsAdd.mockClear();
});

describe("apiOrQueue — offline (issue #909 item 5)", () => {
  it("queues the action locally when fetch() itself throws — a dropped LAN, not a server rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const result = await apiOrQueue(
      "/api/inventory/waste",
      { method: "POST", body: { inventoryItemId: "item-1", quantity: "1" } },
      { type: "inventory.waste.recorded", payload: { inventoryItemId: "item-1" }, description: "ثبت ضایعات" },
    );
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(true);
    expect(pendingActionsAdd).toHaveBeenCalledTimes(1);
    expect(pendingActionsAdd.mock.calls[0][0]).toMatchObject({ type: "inventory.waste.recorded", status: "pending" });
  });

  it("does not queue a server-side rejection — the server answered, so the caller's own error handling applies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({ error: "invalid_quantity" }),
        } as Response),
      ),
    );
    const result = await apiOrQueue<{ error?: string }>(
      "/api/inventory/waste",
      { method: "POST", body: { inventoryItemId: "item-1", quantity: "-1" } },
      { type: "inventory.waste.recorded", payload: { inventoryItemId: "item-1" }, description: "ثبت ضایعات" },
    );
    expect(result.ok).toBe(false);
    expect(result.queued).toBe(false);
    expect(result.data.error).toBe("invalid_quantity");
    expect(pendingActionsAdd).not.toHaveBeenCalled();
  });
});
