import { describe, expect, it } from "vitest";
import { publicationRemoteId, publicationRetryTarget, PUBLICATION_META_KEY } from "./product-publication";
import type { WooProduct } from "./woocommerce-client";

describe("reviewed product publication", () => {
  it("refuses to take over an existing SKU even with the same product name", () => {
    expect(() => publicationRetryTarget([{ id: 1, name: "Same", meta_data: [] } as unknown as WooProduct], "op")).toThrow("sku_already_exists");
  });
  it("recovers only the object created by the same operation after a lost ACK", () => {
    const remote = { id: 7, meta_data: [{ key: PUBLICATION_META_KEY, value: "op" }] } as unknown as WooProduct;
    expect(publicationRetryTarget([remote], "op")).toBe(remote);
    expect(() => publicationRetryTarget([remote], "another")).toThrow();
    expect(() => publicationRetryTarget([remote, remote], "op")).toThrow();
    expect(publicationRetryTarget([], "op")).toBeNull();
  });
  it("rejects missing, synthetic and malformed remote ACK identities", () => {
    for (const id of [null, "local:1", "0", "-1", "12/x", "9007199254740993"]) expect(() => publicationRemoteId(id)).toThrow();
    expect(publicationRemoteId(12)).toBe("12");
  });
});
