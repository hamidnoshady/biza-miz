import { describe, expect, it } from "vitest";
import { capQueueError, redactPayload } from "./payload-redact";

/**
 * Issue #942 (F13): a queue payload shown to an operator must never carry a
 * credential, and customer contact data is masked by default.
 */
describe("redactPayload", () => {
  it("removes credential-shaped keys outright, at any depth", () => {
    const out = redactPayload({
      consumer_secret: "cs_live_123",
      order: {
        billing: { first_name: "Sara" },
        meta: [{ password: "hunter2" }, { authorization: "Basic abc" }],
      },
      token: "t",
      apiKey: "k",
    }) as Record<string, any>;
    expect(out.consumer_secret).toBe("•••");
    expect(out.token).toBe("•••");
    expect(out.apiKey).toBe("•••");
    expect(out.order.meta[0].password).toBe("•••");
    expect(out.order.meta[1].authorization).toBe("•••");
    expect(out.order.billing.first_name).toBe("Sara");
    expect(JSON.stringify(out)).not.toContain("cs_live_123");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("scrubs bearer tokens smuggled inside free-text values", () => {
    const out = redactPayload({ note: "sent with Bearer abc.def.ghi attached" }) as Record<string, string>;
    expect(out.note).toBe("sent with Bearer ••• attached");
  });

  it("partially masks customer contact fields", () => {
    const out = redactPayload({
      email: "Sara@example.com",
      billing_phone: "09123456789",
    }) as Record<string, string>;
    expect(out.email).not.toContain("Sara");
    expect(out.email.endsWith(".com")).toBe(true);
    expect(out.billing_phone).toBe("09•••89");
  });

  it("keeps ordinary operational fields readable", () => {
    const out = redactPayload({ stock_quantity: 7, regular_price: "12500", status: "processing" }) as Record<string, unknown>;
    expect(out).toEqual({ stock_quantity: 7, regular_price: "12500", status: "processing" });
  });

  it("bounds depth, entries and string length", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 12; i += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(JSON.stringify(redactPayload(deep))).toContain("…");

    const long = redactPayload({ body: "x".repeat(5000) }) as Record<string, string>;
    expect(long.body.length).toBeLessThan(600);

    const many = redactPayload({ items: Array.from({ length: 200 }, (_, i) => i) }) as Record<string, unknown[]>;
    expect(many.items.length).toBeLessThan(70);
  });

  it("passes scalars through untouched", () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload("stock")).toBe("stock");
  });
});

describe("capQueueError", () => {
  it("caps and scrubs", () => {
    expect(capQueueError(null)).toBeNull();
    expect(capQueueError("short")).toBe("short");
    expect(capQueueError(`Bearer abc123 ${"y".repeat(900)}`, 100)?.length).toBe(101);
    expect(capQueueError("Bearer abc123 failed")).not.toContain("abc123");
  });
});
