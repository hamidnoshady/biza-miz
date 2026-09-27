import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOrderPaidNotice, storeOrderIdempotencyKeys } from "./store-order-contract";

const contractRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../cms-store-order-contract/v1");
const readFixture = (name: string) => JSON.parse(readFileSync(join(contractRoot, "fixtures", name), "utf8"));

describe("cms-store-order-contract/v1", () => {
  it("parses the committed order-paid-notice fixture", () => {
    const parsed = parseOrderPaidNotice(readFixture("order-paid-notice.json"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.notice.event).toBe("order.paid");
    expect(parsed.notice.order.currency).toBe("IRT");
    const keys = storeOrderIdempotencyKeys(parsed.notice);
    expect(keys.deliveryKey).toBe("del-00000000-0000-4000-8000-000000000001");
    expect(keys.orderKey).toBe("ord-00000000-0000-4000-8000-000000000099");
  });

  it("rejects a duplicate delivery id only at persistence — keys stay stable", () => {
    const first = parseOrderPaidNotice(readFixture("order-paid-notice.json"));
    const second = parseOrderPaidNotice(readFixture("order-paid-notice.json"));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(storeOrderIdempotencyKeys(first.notice)).toEqual(storeOrderIdempotencyKeys(second.notice));
  });

  it("rejects non-paid orders", () => {
    const body = { ...readFixture("order-paid-notice.json"), order: { ...readFixture("order-paid-notice.json").order, status: "pending" } };
    const parsed = parseOrderPaidNotice(body);
    expect(parsed.ok).toBe(false);
  });
});
