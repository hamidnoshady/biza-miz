import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  advanceSyncFence,
  captureRestoreBaseline,
  rlsProtectsRows,
  verifyPostRestore,
  walletBalanceRial,
} from "./tenant-restore-checks";

/**
 * A pinned client whose answers are chosen per question.
 *
 * The module under test asks five different things of one connection, so the
 * fake dispatches on the SQL it is given — the same shape the engine's own test
 * uses — and records what was written so the fence update can be asserted.
 */
function client(overrides: {
  privileged?: boolean;
  wallet?: string | null;
  owners?: number;
  unbalanced?: number;
  generation?: number | null;
} = {}) {
  const written: { text: string; params: unknown[] }[] = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes("rolsuper")) return { rows: [{ privileged: overrides.privileged ?? false }] };
    if (text.includes("balance_rial")) {
      const wallet = overrides.wallet === undefined ? null : overrides.wallet;
      return { rows: wallet === null ? [] : [{ balance_rial: wallet }] };
    }
    if (text.includes("site_generation") && !text.startsWith("UPDATE")) {
      const generation = overrides.generation === undefined ? null : overrides.generation;
      return { rows: generation === null ? [] : [{ site_generation: String(generation) }] };
    }
    if (text.includes("site_generation")) {
      written.push({ text, params });
      return { rows: [] };
    }
    if (text.includes("FROM users")) return { rows: [{ total: String(overrides.owners ?? 1) }] };
    if (text.includes("journal_lines")) return { rows: [{ total: String(overrides.unbalanced ?? 0) }] };
    return { rows: [] };
  });
  return { query, written, asClient: { query } as unknown as PoolClient };
}

describe("rlsProtectsRows", () => {
  it("is the inverse of the role being privileged", async () => {
    expect(await rlsProtectsRows(client().asClient)).toBe(true);
    expect(await rlsProtectsRows(client({ privileged: true }).asClient)).toBe(false);
  });

  it("fails closed when the role cannot be read", async () => {
    const silent = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PoolClient;
    expect(await rlsProtectsRows(silent)).toBe(false);
  });
});

describe("walletBalanceRial", () => {
  it("returns the exact decimal string, and null when there is no wallet row", async () => {
    expect(await walletBalanceRial(client({ wallet: "123456789012345" }).asClient, "biz")).toBe("123456789012345");
    expect(await walletBalanceRial(client().asClient, "biz")).toBeNull();
  });
});

describe("captureRestoreBaseline", () => {
  it("reads the wallet, the Owners and the generation together", async () => {
    const baseline = await captureRestoreBaseline(client({ wallet: "900", owners: 2, generation: 7 }).asClient, "biz");
    expect(baseline).toEqual({ walletBalanceRial: "900", activeOwners: 2, syncGeneration: 7 });
  });
});

describe("advanceSyncFence", () => {
  it("moves one past the newer of the restored and pre-restore generations", async () => {
    // The restored heartbeat came from a backup taken at generation 3, but the
    // site has since reached 9 — the fence must not go backwards to 3.
    const fake = client({ generation: 3 });
    const next = await advanceSyncFence(fake.asClient, "biz", {
      walletBalanceRial: null,
      activeOwners: 1,
      syncGeneration: 9,
    });
    expect(next).toBe(10);
    expect(fake.written).toHaveLength(1);
    expect(fake.written[0].params).toEqual(["biz", 10]);
    // The platform's watermark moves with it, never down.
    expect(fake.written[0].text).toContain("GREATEST(accepted_generation");
  });

  it("still advances when the business has no heartbeat at all", async () => {
    const fake = client({ generation: null });
    expect(
      await advanceSyncFence(fake.asClient, "biz", { walletBalanceRial: null, activeOwners: 1, syncGeneration: 4 }),
    ).toBe(5);
  });

  it("writes nothing when there is no generation on either side", async () => {
    const fake = client({ generation: null });
    expect(
      await advanceSyncFence(fake.asClient, "biz", { walletBalanceRial: null, activeOwners: 1, syncGeneration: null }),
    ).toBeNull();
    expect(fake.written).toHaveLength(0);
  });
});

describe("verifyPostRestore", () => {
  const baseline = { walletBalanceRial: "500", activeOwners: 1, syncGeneration: 2 };

  it("accepts a healthy restore and records every check it made", async () => {
    const verdict = await verifyPostRestore(client({ wallet: "500", owners: 1, generation: 2 }).asClient, "biz", baseline);
    expect(verdict.ok).toBe(true);
    expect(verdict.checks.map((check) => check.code)).toEqual([
      "rls_proven",
      "owner_preserved",
      "accounting_balanced",
      "wallet_unchanged",
      "sync_fence_advanced",
    ]);
    expect(verdict.checks.every((check) => check.ok)).toBe(true);
  });

  it("names every failed check rather than stopping at the first", async () => {
    const verdict = await verifyPostRestore(
      client({ privileged: true, wallet: "0", owners: 0, unbalanced: 2, generation: 2 }).asClient,
      "biz",
      baseline,
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failed).toEqual(["rls_proven", "owner_preserved", "accounting_balanced", "wallet_unchanged"]);
  });

  it("does not invent a wallet comparison for a business that never had one", async () => {
    const verdict = await verifyPostRestore(
      client({ wallet: null }).asClient,
      "biz",
      { walletBalanceRial: null, activeOwners: 1, syncGeneration: 2 },
    );
    expect(verdict.ok).toBe(true);
  });
});
