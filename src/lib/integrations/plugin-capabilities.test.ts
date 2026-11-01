import { describe, expect, it } from "vitest";
import {
  LEGACY_PLUGIN_JOB_TYPES,
  normalizeOrderStatusSlug,
  pluginAdvertisedJobTypes,
  pluginSupportsJobType,
  pluginSupportsLeaseToken,
  registeredOrderStatuses,
} from "./plugin-capabilities";

describe("plugin capability negotiation", () => {
  it("uses the advertised jobTypes when the handshake reported them", () => {
    const caps = { jobTypes: ["stock", "price", "post_upsert", "media_create"] };
    expect(pluginAdvertisedJobTypes(caps)).toEqual(["stock", "price", "post_upsert", "media_create"]);
    expect(pluginSupportsJobType(caps, "media_create")).toBe(true);
    expect(pluginSupportsJobType(caps, "refund_create")).toBe(false);
  });

  it("falls back to the legacy pre-capability set when nothing (or junk) was advertised", () => {
    for (const caps of [null, undefined, {}, { jobTypes: [] }, { jobTypes: "stock" }, { jobTypes: [1, 2] }]) {
      expect(pluginAdvertisedJobTypes(caps as never)).toEqual([...LEGACY_PLUGIN_JOB_TYPES]);
    }
    // A legacy plugin can push stock but must never be handed a content job.
    expect(pluginSupportsJobType(null, "stock")).toBe(true);
    expect(pluginSupportsJobType(null, "media_create")).toBe(false);
    expect(pluginSupportsJobType(null, "post_upsert")).toBe(false);
  });

  it("ignores non-string entries without losing the valid ones", () => {
    expect(pluginAdvertisedJobTypes({ jobTypes: ["stock", 3, null, "media_create"] })).toEqual([
      "stock",
      "media_create",
    ]);
  });

  // Issue #942 (F01): only protocol ≥ 3 plugins echo lease tokens, so only
  // they are issued (and fenced by) one — older plugins keep the legacy path.
  it("issues lease tokens only to protocol 3+ plugins", () => {
    expect(pluginSupportsLeaseToken({ protocolVersion: 3 })).toBe(true);
    expect(pluginSupportsLeaseToken({ protocolVersion: 4 })).toBe(true);
    expect(pluginSupportsLeaseToken({ protocolVersion: 2 })).toBe(false);
    expect(pluginSupportsLeaseToken({ protocolVersion: 1 })).toBe(false);
    expect(pluginSupportsLeaseToken({})).toBe(false);
    expect(pluginSupportsLeaseToken(null)).toBe(false);
    expect(pluginSupportsLeaseToken({ protocolVersion: "3" })).toBe(false);
  });
});

// Issue #1215 / P1-3: the store's registered order statuses are the only
// truthful source of a status's display name, and the handshake stores what
// this reader accepts — so the rules below are also the storage rules.
describe("registered order statuses", () => {
  it("reads the [{slug,label}] registry and strips WooCommerce's wc- prefix", () => {
    expect(
      registeredOrderStatuses({
        orderStatuses: [
          { slug: "wc-shipped", label: "ارسال شد" },
          { slug: "awaiting-pickup", label: "در انتظار تحویل" },
        ],
      }),
    ).toEqual([
      { slug: "shipped", label: "ارسال شد" },
      { slug: "awaiting-pickup", label: "در انتظار تحویل" },
    ]);
  });

  it("tolerates the associative slug→label shape", () => {
    expect(registeredOrderStatuses({ orderStatuses: { "wc-processing": "در حال آماده‌سازی" } })).toEqual([
      { slug: "processing", label: "در حال آماده‌سازی" },
    ]);
  });

  it("drops junk instead of trusting it", () => {
    expect(
      registeredOrderStatuses({
        orderStatuses: [
          { slug: "shipped", label: "ارسال شد" },
          { slug: "shipped", label: "تکراری" },
          { slug: "bad slug!", label: "نامعتبر" },
          { slug: "", label: "بی‌شناسه" },
          { slug: 7, label: "عدد" },
          { slug: "no-label" },
          null,
          "shipped",
          { slug: "x".repeat(60), label: "بیش از حد" },
        ],
      }),
    ).toEqual([{ slug: "shipped", label: "ارسال شد" }]);
  });

  it("keeps labels bounded and returns nothing for a plugin that reported none", () => {
    const long = registeredOrderStatuses({ orderStatuses: [{ slug: "shipped", label: "x".repeat(200) }] });
    expect(long[0].label).toHaveLength(80);
    for (const caps of [null, undefined, {}, { orderStatuses: [] }, { orderStatuses: "shipped" }, { orderStatuses: {} }]) {
      expect(registeredOrderStatuses(caps as never)).toEqual([]);
    }
  });

  it("normalizes a slug the same way everywhere wc- appears", () => {
    expect(normalizeOrderStatusSlug("wc-on-hold")).toBe("on-hold");
    expect(normalizeOrderStatusSlug(" Processing ")).toBe("processing");
    expect(normalizeOrderStatusSlug("bad slug")).toBe("");
    expect(normalizeOrderStatusSlug(null)).toBe("");
  });
});
