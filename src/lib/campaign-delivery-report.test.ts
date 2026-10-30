/**
 * Issue #902 §6 (plan §9 item 2) — the pure half of the per-campaign report.
 *
 * The query needs a database; the decisions do not. What is worth proving here
 * is that the report cannot lie in the two ways this kind of report usually
 * does: by collapsing "we measured nothing" into a zero, and by letting one bad
 * sample vanish into an average.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latencyStats } from "./campaign-delivery-report";

describe("latency percentiles", () => {
  it("says nothing rather than zero when nothing was measured", () => {
    // `null`, not `{p50: 0}`: "no data" and "instant" are different facts, and
    // a report that prints 0 ms for silence is a report an operator quotes.
    expect(latencyStats([])).toBeNull();
    expect(latencyStats([null, undefined])).toBeNull();
    // Values the column could hold but the drain never writes.
    expect(latencyStats([-1, Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("reports the sample itself for a single measurement", () => {
    expect(latencyStats([420])).toEqual({ count: 1, p50: 420, p95: 420, max: 420 });
  });

  it("uses nearest-rank percentiles, so one slow send still shows at p95", () => {
    // Nineteen fast sends and one 90-second retry: the average would be ~4.5 s
    // and would read as "fine", which is exactly the report this one replaces.
    const values = [...Array.from({ length: 19 }, () => 200), 90_000];
    const stats = latencyStats(values)!;
    expect(stats.count).toBe(20);
    expect(stats.p50).toBe(200);
    expect(stats.p95).toBe(200);
    expect(stats.max).toBe(90_000);

    // With a real tail, p95 lands in the tail.
    const spread = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 5_000];
    expect(latencyStats(spread)).toEqual({ count: 12, p50: 150, p95: 5_000, max: 5_000 });
  });

  it("ignores the unmeasured rows mixed in with the measured ones", () => {
    // Every outbox row queued before migration 0268 has a null send latency;
    // they must not be counted as zeros.
    expect(latencyStats([null, 300, undefined, 100])).toEqual({
      count: 2,
      p50: 100,
      p95: 300,
      max: 300,
    });
  });

  it("does not require its input to be sorted, and does not mutate it", () => {
    const values = [900, 100, 500];
    expect(latencyStats(values)?.p50).toBe(500);
    expect(values).toEqual([900, 100, 500]);
  });
});

describe("the tenant view is safe by construction", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./campaign-delivery-report.ts", import.meta.url)),
    "utf8",
  );

  it("carries no provider name and no provider error string", () => {
    expect(source).not.toMatch(/kavenegar|parspack|zarinpal/i);
    // `message_outbox.error` holds a provider code label: platform diagnostics,
    // never tenant copy. It must not be selected into the shared row shape.
    expect(source).not.toMatch(/o\.error/);
    expect(source).not.toMatch(/provider_message_id/);
  });

  it("scopes the tenant query twice — by the caller's business and by RLS", () => {
    const tenantQuery = source.slice(source.indexOf("export async function tenantCampaignDelivery"));
    expect(tenantQuery).toContain("withTenant(businessId");
    expect(tenantQuery).toContain("o.business_id = $1");
  });

  it("keeps the cross-tenant read behind the documented platform bypass", () => {
    const platformQuery = source.slice(
      source.indexOf("export async function getCampaignDeliveryReport"),
      source.indexOf("export async function tenantCampaignDelivery"),
    );
    expect(platformQuery).toContain('withoutTenantScope("platform"');
  });
});
