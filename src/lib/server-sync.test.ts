import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { isDependencyRefusal, legacySyncTokenAllowed } from "./server-sync";

describe("server-sync", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("legacySyncTokenAllowed() defaults to false", () => {
    delete process.env.ALLOW_LEGACY_SYNC_TOKEN;
    expect(legacySyncTokenAllowed()).toBe(false);

    process.env.ALLOW_LEGACY_SYNC_TOKEN = "0";
    expect(legacySyncTokenAllowed()).toBe(false);

    process.env.ALLOW_LEGACY_SYNC_TOKEN = "1";
    expect(legacySyncTokenAllowed()).toBe(true);
  });
});

describe("isDependencyRefusal", () => {
  it("recognises a missing master row as a wait, not a poison event", () => {
    // The shape runServerPush stores: `remote_apply_failed: <code>`.
    expect(isDependencyRefusal("remote_apply_failed: customer_not_found")).toBe(true);
    expect(isDependencyRefusal("remote_apply_failed: menu_item_not_found")).toBe(true);
    expect(isDependencyRefusal("remote_apply_failed: dependency_missing")).toBe(true);
    expect(isDependencyRefusal("remote_apply_failed: supplier_required")).toBe(true);
  });

  it("leaves a real refusal on the bounded-backoff path", () => {
    expect(isDependencyRefusal("remote_apply_failed: boom")).toBe(false);
    expect(isDependencyRefusal("remote_apply_failed: invalid_order_type")).toBe(false);
    // A business refusal that merely contains the word must not be mistaken
    // for a dependency: the code has to be the whole token.
    expect(isDependencyRefusal("remote_apply_failed: not_customer_not_found_but_bad")).toBe(false);
    expect(isDependencyRefusal(null)).toBe(false);
  });
});
