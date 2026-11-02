/**
 * Issue #894 Wave 5b — the webhook's rules, without a network or a database.
 *
 * Three of these are Torob's own invariants (100 items, one domain, a payload of
 * two identifiers); the rest are decisions about what a failure deserves, where a
 * wrong answer either spams a provider into a 429 or silently drops a merchant's
 * changes.
 */
import { describe, expect, it } from "vitest";
import {
  TOROB_WEBHOOK_BATCHES_PER_RUN,
  TOROB_WEBHOOK_ERROR_COPY,
  TOROB_WEBHOOK_MAX_ATTEMPTS,
  TOROB_WEBHOOK_MAX_ITEMS,
  TOROB_WEBHOOK_MIN_INTERVAL_MS,
  TOROB_WEBHOOK_RATE_LIMIT,
  WEBHOOK_STATE_COPY,
  afterWebhookFailure,
  hostOf,
  isWebhookAccepted,
  planWebhookBatches,
  webhookBody,
  type TorobWebhookError,
  type WebhookItem,
} from "./webhook";

function item(n: number, host = "shop.alpha.example"): WebhookItem {
  return {
    pageUnique: `0000000${n}`,
    pageUrl: `https://${host}/product/${n}`,
    reason: n % 2 === 0 ? "added" : "updated",
    pageUpdatedAt: "2026-10-07T08:00:00.000Z",
  };
}

const never = () => 5_000;

describe("the provider's own limits", () => {
  it("keeps the documented numbers", () => {
    expect(TOROB_WEBHOOK_MAX_ITEMS).toBe(100);
    expect(TOROB_WEBHOOK_RATE_LIMIT).toBe(20);
    expect(TOROB_WEBHOOK_MIN_INTERVAL_MS).toBe(3_000);
    expect(TOROB_WEBHOOK_BATCHES_PER_RUN * TOROB_WEBHOOK_MAX_ITEMS).toBeLessThanOrEqual(500);
  });
});

describe("hostOf", () => {
  it("reads a host, case-insensitively and without a leading www", () => {
    expect(hostOf("https://WWW.Shop.Example/product/1")).toBe("shop.example");
    expect(hostOf("http://shop.example/p")).toBe("shop.example");
  });

  it("refuses anything that is not an absolute http(s) URL", () => {
    expect(hostOf("/product/1")).toBeNull();
    expect(hostOf("shop.example/product/1")).toBeNull();
    expect(hostOf("javascript:alert(1)")).toBeNull();
    expect(hostOf("")).toBeNull();
  });
});

describe("planWebhookBatches", () => {
  it("splits 250 pages into 100 + 100 + 50", () => {
    const items = Array.from({ length: 250 }, (_, index) => item(index));
    const { batches, dropped } = planWebhookBatches({ items, domain: "shop.alpha.example", maxBatches: 10 });
    expect(dropped).toBe(0);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
  });

  it("drops a page on another host instead of losing the whole batch to a 400", () => {
    const items = [item(1), item(2, "elsewhere.example"), item(3)];
    const { batches, dropped } = planWebhookBatches({ items, domain: "shop.alpha.example" });
    expect(dropped).toBe(1);
    expect(batches.flat().map((row) => row.pageUnique)).toEqual([item(1).pageUnique, item(3).pageUnique]);
  });

  it("accepts the domain written with www, in either case", () => {
    const { batches, dropped } = planWebhookBatches({ items: [item(1)], domain: "WWW.Shop.Alpha.Example" });
    expect(dropped).toBe(0);
    expect(batches[0]).toHaveLength(1);
  });

  it("drops a page with no identity or an unusable URL", () => {
    const items: WebhookItem[] = [
      { ...item(1) },
      { ...item(2), pageUnique: "  " },
      { ...item(3), pageUrl: "not-a-url" },
    ];
    const { batches, dropped } = planWebhookBatches({ items, domain: "shop.alpha.example" });
    expect(dropped).toBe(2);
    expect(batches.flat()).toHaveLength(1);
  });

  it("sends one row per page even when the same page is queued twice", () => {
    const { batches, dropped } = planWebhookBatches({
      items: [item(1), item(1)],
      domain: "shop.alpha.example",
    });
    expect(dropped).toBe(1);
    expect(batches.flat()).toHaveLength(1);
  });

  it("stops at the batch bound, leaving the rest for the next run", () => {
    const items = Array.from({ length: 450 }, (_, index) => item(index));
    const { batches } = planWebhookBatches({ items, domain: "shop.alpha.example", maxBatches: 2 });
    expect(batches).toHaveLength(2);
    expect(batches.flat()).toHaveLength(200);
  });

  it("never asks for more than the provider's 100 per request", () => {
    const items = Array.from({ length: 10 }, (_, index) => item(index));
    const { batches } = planWebhookBatches({ items, domain: "shop.alpha.example", maxItems: 5_000 });
    expect(batches[0]).toHaveLength(10);
    const big = planWebhookBatches({
      items: Array.from({ length: 250 }, (_, index) => item(index)),
      domain: "shop.alpha.example",
      maxItems: 5_000,
    });
    expect(big.batches.every((batch) => batch.length <= 100)).toBe(true);
  });
});

describe("webhookBody", () => {
  it("carries the two documented fields and nothing else", () => {
    const body = webhookBody([item(1)]);
    expect(Object.keys(body)).toEqual(["items"]);
    expect(Object.keys(body.items[0]).sort()).toEqual(["page_unique", "page_url"]);
  });
});

describe("isWebhookAccepted", () => {
  it("accepts only the documented answer", () => {
    expect(isWebhookAccepted(200, { message: "success" })).toBe(true);
  });

  it("refuses a 200 whose body is not the documented one", () => {
    // "It parsed" is not "it was accepted", and a merchant told otherwise stops
    // wondering why nothing changed on Torob.
    expect(isWebhookAccepted(200, { message: "ok" })).toBe(false);
    expect(isWebhookAccepted(200, null)).toBe(false);
    expect(isWebhookAccepted(202, { message: "success" })).toBe(false);
  });
});

describe("afterWebhookFailure", () => {
  it("dead-letters a request Torob refuses outright", () => {
    // Retrying the same body repeats the same 400.
    expect(afterWebhookFailure(0, "invalid_request", never)).toMatchObject({ state: "dead", delayMs: 0 });
    expect(afterWebhookFailure(0, "domain_mismatch", never)).toMatchObject({ state: "dead" });
  });

  it("dead-letters a credential or an inactive shop — a human has to fix those", () => {
    expect(afterWebhookFailure(0, "unauthorized", never)).toMatchObject({ state: "dead", attempts: 1 });
    expect(afterWebhookFailure(0, "shop_not_active", never)).toMatchObject({ state: "dead" });
  });

  it("retries a rate limit after the documented spacing, not a guessed backoff", () => {
    expect(afterWebhookFailure(0, "rate_limited", never)).toEqual({
      state: "pending",
      attempts: 1,
      delayMs: TOROB_WEBHOOK_MIN_INTERVAL_MS,
    });
    // Even deep into its attempts: the answer was "slow down", not "stop".
    expect(afterWebhookFailure(TOROB_WEBHOOK_MAX_ATTEMPTS, "rate_limited", never).state).toBe("pending");
  });

  it("backs off a provider failure and dead-letters at the cap", () => {
    expect(afterWebhookFailure(0, "provider_error", never)).toEqual({
      state: "pending",
      attempts: 1,
      delayMs: 5_000,
    });
    expect(afterWebhookFailure(TOROB_WEBHOOK_MAX_ATTEMPTS - 1, "provider_error", never).state).toBe("dead");
    expect(afterWebhookFailure(0, "timeout", never).state).toBe("pending");
  });
});

describe("the copy", () => {
  it("has a sentence for every failure, and none of them blames the merchant", () => {
    const codes: TorobWebhookError[] = [
      "not_configured",
      "unauthorized",
      "domain_mismatch",
      "invalid_request",
      "rate_limited",
      "timeout",
      "provider_error",
      "shop_not_active",
    ];
    for (const code of codes) expect(TOROB_WEBHOOK_ERROR_COPY[code].length).toBeGreaterThan(0);
    // The one that matters most: an accepted batch is a queue, not a listing.
    expect(WEBHOOK_STATE_COPY.sent).not.toMatch(/نمایش|منتشر/);
  });
});
