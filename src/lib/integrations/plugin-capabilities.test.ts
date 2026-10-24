import { describe, expect, it } from "vitest";
import {
  LEGACY_PLUGIN_JOB_TYPES,
  pluginAdvertisedJobTypes,
  pluginSupportsJobType,
  pluginSupportsLeaseToken,
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
