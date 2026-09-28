import { describe, expect, it, vi } from "vitest";
import { lockOpenOrder } from "./order-lock";

function clientWith(rows: Record<string, unknown>[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

describe("lockOpenOrder", () => {
  it("locks the parent row and returns the locked financial fields", async () => {
    const client = clientWith([{ id: "order-1", status: "open", total: "100", tax: "9" }]);
    const result = await lockOpenOrder(client as never, "location-1", "order-1");

    expect(result.ok).toBe(true);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), ["order-1", "location-1"]);
  });

  it("distinguishes missing from no-longer-open orders and requires held orders to resume", async () => {
    await expect(lockOpenOrder(clientWith([]) as never, "location-1", "missing")).resolves.toEqual({
      ok: false,
      error: "order_not_found",
      status: 404,
    });
    await expect(
      lockOpenOrder(clientWith([{ id: "order-1", status: "completed" }]) as never, "location-1", "order-1"),
    ).resolves.toEqual({ ok: false, error: "order_not_open", status: 409 });
    await expect(
      lockOpenOrder(clientWith([{ id: "order-2", status: "held" }]) as never, "location-1", "order-2"),
    ).resolves.toEqual({ ok: false, error: "order_not_open", status: 409 });
  });
});
