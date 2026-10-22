import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

/**
 * Issue #1006 follow-up — `withTenantTransaction` learns to *join* a
 * transaction that is already pinned (`pinToClient`).
 *
 * Why this needs its own test: a second `BEGIN`/`COMMIT` pair on a pg client
 * that is already inside a transaction is not a nested transaction (Postgres
 * has no such thing) and is not a savepoint either — the inner `COMMIT` commits
 * the outer transaction early and the inner `ROLLBACK` discards everything the
 * caller did before the call. Every caller of `withTenantTransaction` now
 * depends on the join behaviour, so the contract is pinned here:
 *
 *   - standalone:    BEGIN … COMMIT on success, BEGIN … ROLLBACK on throw;
 *   - already pinned: no BEGIN / COMMIT / ROLLBACK of its own — the owner of
 *     the pinned transaction decides, whether that decision is commit or
 *     rollback, and the error still propagates so the owner can see it.
 */

const h = vi.hoisted(() => {
  const statements: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    statements.push(String(sql).trim());
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  const end = vi.fn(async () => {});
  return { statements, release, query, connect, end };
});

vi.mock("pg", () => ({
  Pool: class {
    connect = h.connect;
    query = h.query;
    end = h.end;
    on() {
      return this;
    }
  },
}));

// getPool() refuses to build a pool without a URL; nothing ever dials it
// because `connect` is the stub above.
process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:5432/test";

const { isPinnedToTransaction, pinToClient, query, withTenantTransaction } = await import("./db");

/** Only the transaction-control statements, in order. */
function txStatements(): string[] {
  return h.statements.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
}

/** A client that is already inside somebody else's transaction. */
function pinnedClient(): PoolClient {
  return { query: h.query, release: h.release } as unknown as PoolClient;
}

beforeEach(() => {
  h.statements.length = 0;
  h.connect.mockClear();
  h.release.mockClear();
  h.query.mockClear();
});

describe("withTenantTransaction without a pinned transaction", () => {
  it("opens its own transaction and commits it", async () => {
    const result = await withTenantTransaction("biz-1", async () => {
      await query("UPDATE parties SET x = 1");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(txStatements()).toEqual(["BEGIN", "COMMIT"]);
    expect(h.release).toHaveBeenCalledTimes(1);
    // The callback's own statement ran on the same pinned connection.
    expect(h.statements).toContain("UPDATE parties SET x = 1");
  });

  it("rolls its own transaction back when the callback throws", async () => {
    await expect(
      withTenantTransaction("biz-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(txStatements()).toEqual(["BEGIN", "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe("withTenantTransaction inside an already-pinned transaction", () => {
  it("joins it, emits no BEGIN/COMMIT of its own, and leaves the commit to its owner", async () => {
    const client = pinnedClient();
    let sawPin = false;

    const result = await pinToClient(client, async () => {
      const inner = await withTenantTransaction("biz-1", async () => {
        sawPin = isPinnedToTransaction();
        await query("UPDATE parties SET accounting_code = '300001'");
        return 42;
      });
      // The owner commits once, after the nested call returned.
      await client.query("COMMIT");
      return inner;
    });

    expect(result).toBe(42);
    expect(sawPin).toBe(true);
    // No second checkout: the nested call reused the pinned client.
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    // Exactly one COMMIT — the owner's. A nested one would have ended the
    // outer transaction early while the callback was still running.
    expect(txStatements()).toEqual(["COMMIT"]);
    expect(h.statements).toContain("UPDATE parties SET accounting_code = '300001'");
  });

  it("joins it and issues no ROLLBACK when the inner callback throws, so the owner can decide", async () => {
    const client = pinnedClient();

    await expect(
      pinToClient(client, async () => {
        try {
          await withTenantTransaction("biz-1", async () => {
            await query("UPDATE parties SET x = 1");
            throw new Error("inner failure");
          });
        } catch (error) {
          // The owner sees the error and rolls back the one transaction it
          // owns — the same single rollback a plain sequential call would get.
          expect((error as Error).message).toBe("inner failure");
          await client.query("ROLLBACK");
        }
      }),
    ).resolves.toBeUndefined();

    expect(h.connect).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    // One ROLLBACK: the owner's. The nested call must not have emitted one,
    // which would have silently discarded the owner's earlier writes.
    expect(txStatements()).toEqual(["ROLLBACK"]);
  });
});
