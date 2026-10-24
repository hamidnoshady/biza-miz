import { beforeEach, describe, expect, it, vi } from "vitest";
import { query, withoutTenantScope } from "../db";
import { pruneExpiredWooSnapshots } from "./woo-history-service";

vi.mock("../db", () => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
}));

beforeEach(() => vi.clearAllMocks());

describe("Woo fallback snapshot retention", () => {
  it("uses a background-only platform sweep that erases ciphertext and returns only a count", async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 3, rows: [] } as never);
    expect(await pruneExpiredWooSnapshots()).toBe(3);
    expect(withoutTenantScope).toHaveBeenCalledWith("platform", expect.any(Function));
    expect(query).toHaveBeenCalledTimes(1);
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).toContain("SET render_snapshot = NULL");
    expect(sql).toContain("document_type IN ('shipping_label', 'woo_invoice')");
    expect(sql).toContain("created_at < now() - interval '30 days'");
    expect(sql).not.toMatch(/RETURNING|SELECT|DELETE/i);
  });
  it("returns zero for a no-op, not any recipient records", async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: null, rows: [] } as never);
    expect(await pruneExpiredWooSnapshots()).toBe(0);
  });
  it("lets the existing background scheduler handle database failures", async () => {
    vi.mocked(query).mockRejectedValue(new Error("offline"));
    await expect(pruneExpiredWooSnapshots()).rejects.toThrow("offline");
  });
});
