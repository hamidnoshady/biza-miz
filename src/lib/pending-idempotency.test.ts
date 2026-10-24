import { describe, expect, it } from "vitest";
import { clearPendingIdempotencyKey, payloadFingerprint, pendingIdempotencyKey } from "./pending-idempotency";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("pending idempotency key persistence (issue #915)", () => {
  it("reuses the stored key for a byte-identical payload — a reload resubmits as a replay, not a duplicate", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;
    const payload = { supplierId: "s1", lines: [{ itemId: "i1", quantity: "2", unitCost: "5000" }] };

    const first = pendingIdempotencyKey(storage, "stock.purchase", payload, generate);
    // Simulated reload: new call, same storage, same payload.
    const afterReload = pendingIdempotencyKey(storage, "stock.purchase", payload, generate);
    expect(first).toBe("key-1");
    expect(afterReload).toBe("key-1");
  });

  it("a changed payload gets a fresh key — a spent key is never reused for different content", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;

    const a = pendingIdempotencyKey(storage, "stock.purchase", { q: "1" }, generate);
    const b = pendingIdempotencyKey(storage, "stock.purchase", { q: "2" }, generate);
    expect(a).toBe("key-1");
    expect(b).toBe("key-2");
    // And the stored entry now belongs to the new payload.
    expect(pendingIdempotencyKey(storage, "stock.purchase", { q: "2" }, generate)).toBe("key-2");
  });

  it("clearing after a known outcome issues a fresh key for the next submission of the same payload", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;
    const payload = { q: "1" };

    expect(pendingIdempotencyKey(storage, "stock.purchase", payload, generate)).toBe("key-1");
    clearPendingIdempotencyKey(storage, "stock.purchase");
    expect(pendingIdempotencyKey(storage, "stock.purchase", payload, generate)).toBe("key-2");
  });

  it("scopes are independent — a pending purchase never lends its key to a return", () => {
    const storage = memoryStorage();
    let n = 0;
    const generate = () => `key-${++n}`;
    const payload = { q: "1" };

    expect(pendingIdempotencyKey(storage, "stock.purchase", payload, generate)).toBe("key-1");
    expect(pendingIdempotencyKey(storage, "stock.return", payload, generate)).toBe("key-2");
  });

  it("survives corrupted or unavailable storage by degrading to a fresh key", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const key = pendingIdempotencyKey(broken, "stock.purchase", { q: "1" }, () => "fresh");
    expect(key).toBe("fresh");

    const storage = memoryStorage();
    storage.setItem("pending-idempotency:stock.purchase", "{not json");
    expect(pendingIdempotencyKey(storage, "stock.purchase", { q: "1" }, () => "fresh-2")).toBe("fresh-2");
  });

  it("fingerprints are stable for equal payloads and differ when content differs", () => {
    expect(payloadFingerprint({ a: 1, b: "x" })).toBe(payloadFingerprint({ a: 1, b: "x" }));
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: 2 }));
  });
});
