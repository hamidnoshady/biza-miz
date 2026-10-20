/**
 * Issue #913 items 1 & 2 — the payload fingerprint behind exactly-once
 * checkout. Pure logic, so it lives here beside its callers' suites:
 * same key + same intent = same hash, whatever the JSON key order or an
 * omitted-vs-undefined detail; any business change to the payload = a
 * different hash (the 409 conflict signal); replay mechanics never move it.
 */
import { describe, expect, it } from "vitest";
import {
  isValidClientRequestId,
  normalizeClientRequestId,
  orderRequestFingerprint,
  retailInvoiceRequestFingerprint,
} from "./checkout-idempotency";

const baseOrder = {
  type: "dine_in",
  tableId: "t-1",
  customerId: null,
  guestCount: 2,
  note: null,
  discount: { type: "percent" as const, value: 10 },
  items: [
    { menuItemId: "m-1", quantity: 2, modifiers: [{ id: "x", quantity: 1 }] },
    { menuItemId: "m-2", quantity: 1 },
  ],
  delivery: null,
};

describe("orderRequestFingerprint", () => {
  it("is stable across key order and an omitted (vs undefined) optional", () => {
    const reordered = {
      delivery: undefined,
      discount: { value: 10, type: "percent" },
      guestCount: 2,
      items: [
        { modifiers: [{ quantity: 1, id: "x" }], quantity: 2, menuItemId: "m-1" },
        { menuItemId: "m-2", quantity: 1 },
      ],
      note: undefined,
      tableId: "t-1",
      customerId: undefined,
      type: "dine_in",
    };
    expect(orderRequestFingerprint(reordered)).toBe(orderRequestFingerprint(baseOrder));
  });

  it("changes when the business intent changes", () => {
    const variants = [
      { ...baseOrder, type: "takeaway" },
      { ...baseOrder, tableId: "t-2" },
      { ...baseOrder, customerId: "c-1" },
      { ...baseOrder, guestCount: 3 },
      { ...baseOrder, note: "no onions" },
      { ...baseOrder, discount: { type: "percent" as const, value: 11 } },
      { ...baseOrder, discount: { type: null } },
      { ...baseOrder, items: baseOrder.items.slice(0, 1) },
      {
        ...baseOrder,
        items: [{ ...baseOrder.items[0], quantity: 3 }, baseOrder.items[1]],
      },
      {
        ...baseOrder,
        delivery: { address: "x", phone: null, fee: 0, courierId: null, note: null },
      },
    ];
    const seen = new Set([orderRequestFingerprint(baseOrder)]);
    for (const variant of variants) {
      const fp = orderRequestFingerprint(variant);
      expect(seen.has(fp), JSON.stringify(variant)).toBe(false);
      seen.add(fp);
    }
  });

  it("ignores replay mechanics — the key, the ids and the clock are not intent", () => {
    const a = orderRequestFingerprint(baseOrder);
    // A queued replay arrives with the ids the transport added; a peer's
    // outbox payload carries orderId/itemIds. None may move the fingerprint.
    // (Cast: the signature names only the intent fields on purpose — unknown
    // transport fields must fall off, not fail the call.)
    const b = orderRequestFingerprint({
      ...baseOrder,
      clientRequestId: "k-1",
      orderId: "o-1",
      itemIds: ["a"],
    } as never);
    const c = orderRequestFingerprint({
      ...baseOrder,
      clientRequestId: "k-2",
      openedAt: 1729363200000,
    } as never);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("treats an empty cart and a missing cart as the same intent", () => {
    expect(orderRequestFingerprint({ ...baseOrder, items: undefined })).toBe(
      orderRequestFingerprint({ ...baseOrder, items: [] }),
    );
  });
});

describe("retailInvoiceRequestFingerprint", () => {
  const base = {
    lines: [{ kind: "accessory", itemId: "i-1", quantity: "2", vatPercent: 9 }],
    tenders: [{ method: "cash", amount: "109000" }],
    customerId: null,
    note: null,
  };

  it("is stable across key order", () => {
    expect(
      retailInvoiceRequestFingerprint({
        note: null,
        customerId: null,
        tenders: [{ amount: "109000", method: "cash" }],
        lines: [{ vatPercent: 9, quantity: "2", itemId: "i-1", kind: "accessory" }],
      }),
    ).toBe(retailInvoiceRequestFingerprint(base));
  });

  it("changes when a line, a tender or the customer changes", () => {
    const fp = retailInvoiceRequestFingerprint(base);
    expect(retailInvoiceRequestFingerprint({ ...base, lines: [{ ...base.lines[0], quantity: "3" }] })).not.toBe(fp);
    expect(retailInvoiceRequestFingerprint({ ...base, tenders: [{ method: "cash", amount: "99000" }] })).not.toBe(fp);
    expect(retailInvoiceRequestFingerprint({ ...base, customerId: "c-1" })).not.toBe(fp);
  });

  it("never lets the branch's business date move it — a retry after midnight is the same purchase", () => {
    expect(retailInvoiceRequestFingerprint({ ...base, businessDate: "2026-10-19" } as never)).toBe(
      retailInvoiceRequestFingerprint({ ...base, businessDate: "2026-10-20" } as never),
    );
  });
});

describe("client request id normalization", () => {
  it("trims and bounds a usable key", () => {
    expect(normalizeClientRequestId("  abc  ")).toBe("abc");
    expect(normalizeClientRequestId(`  ${"x".repeat(200)}  `)).toBe("x".repeat(200));
    expect(isValidClientRequestId("abc")).toBe(true);
  });

  it("rejects empty, oversized and wrong-typed keys outright", () => {
    for (const bad of ["", "   ", "x".repeat(201), 42, null, undefined, { id: 1 }]) {
      expect(normalizeClientRequestId(bad), JSON.stringify(bad)).toBeNull();
      expect(isValidClientRequestId(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("orders INSERT statements pair the key with its fingerprint (issue #913 item 2)", () => {
  /**
   * `orders_client_request_pairing` (migration 0232) rejects any row that
   * sets `client_request_id` without `request_fingerprint` and vice versa.
   * The two app writers pair them by construction; every OTHER raw path —
   * peer state sync, CMS/webhook/Holoo imports, seed scripts — must write
   * NEITHER. A future insert that copies just the key would fail at runtime
   * on every row, so the source audit fails here first, naming the file.
   */
  it("never sets client_request_id without request_fingerprint in any INSERT INTO orders", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

    const insertRe = /INSERT\s+INTO\s+"?orders"?\s*\(([\s\S]*?)\)/gi;
    const offenders: string[] = [];
    let sites = 0;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx|mts)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(insertRe)) {
          sites += 1;
          const columns = match[1].toLowerCase();
          const hasKey = /\bclient_request_id\b/.test(columns);
          const hasFingerprint = /\brequest_fingerprint\b/.test(columns);
          if (hasKey !== hasFingerprint) {
            offenders.push(
              `${path.replace(repoRoot, "")}: INSERT lists ${hasKey ? "client_request_id without request_fingerprint" : "request_fingerprint without client_request_id"}`,
            );
          }
        }
      }
    };
    walk(join(repoRoot, "src"));
    walk(join(repoRoot, "scripts"));

    // The audit is worthless if the regex stopped matching the known writers.
    expect(sites).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });
});
