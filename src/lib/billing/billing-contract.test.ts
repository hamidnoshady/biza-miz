import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  signLegacyUsageBody,
  verifyLegacyUsageSignature,
} from "./auth/compat/legacy-nonce-body-hash";
import { signBillingBody, verifyBillingBodySignature, BILLING_REPLAY_WINDOW_MS } from "./auth/sign";
import { parseBatchAck } from "./client/interpret";
import { parseEntitlementPush, parseUsageBatch, parseUsageEvent } from "./contract/v1";

const contractRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/billing-contract/v1");
const readFixture = (name: string) => JSON.parse(readFileSync(join(contractRoot, "fixtures", name), "utf8"));
const readVectors = () =>
  JSON.parse(readFileSync(join(contractRoot, "hmac-test-vectors.json"), "utf8")) as {
    vectors: { body: string; id: string; secret: string; signature: string; timestampSec: string }[];
  };

const site = "11111111-1111-1111-1111-111111111111";

describe("billing-contract/v1", () => {
  it("parses committed fixture batches and acks", () => {
    const batch = readFixture("usage-measurement-batch.json");
    expect("batch" in parseUsageBatch(batch)).toBe(true);
    const ack = readFixture("usage-ack.json");
    const parsedAck = parseBatchAck(ack);
    expect("results" in parsedAck).toBe(true);
    if ("results" in parsedAck) expect(parsedAck.results).toHaveLength(3);
    const projection = readFixture("entitlement-push.json");
    expect("payload" in parseEntitlementPush(projection)).toBe(true);
  });

  it("rejects legacy aggregate ingest acknowledgements", () => {
    const legacy = parseBatchAck({ accepted: 1, duplicates: 0, rejected: [] });
    expect("error" in legacy).toBe(true);
  });

  it("rejects flat numeric limits on entitlement push", () => {
    const parsed = parseEntitlementPush({
      features: {},
      limits: { pages: 10 },
      planCode: "pro",
      serving: true,
      siteId: site,
      version: 1,
    });
    expect("error" in parsed).toBe(true);
  });

  it("rejects prices, wallets and business ids on usage events", () => {
    const parsed = parseUsageEvent({
      businessId: "biz_1",
      eventId: "cms:11111111-1111-1111-1111-111111111111:api_request:1",
      meterKey: "cms.api_request",
      price: 10,
      quantity: 1,
      siteId: site,
      unit: "request",
      periodStart: "2026-09-26T13:00:00.000Z",
      periodEnd: "2026-09-26T14:00:00.000Z",
      occurredAt: "2026-09-26T13:00:00.000Z",
    });
    expect("error" in parsed).toBe(true);
  });

  it("accepts cms.storage_byte_hour and cms.build_second meters", () => {
    for (const meterKey of ["cms.storage_byte_hour", "cms.build_second"]) {
      const unit = meterKey === "cms.storage_byte_hour" ? "byte_hour" : "second";
      const parsed = parseUsageEvent({
        eventId: `cms:${site}:${meterKey}:1`,
        meterKey,
        quantity: 1,
        siteId: site,
        unit,
        periodStart: "2026-09-26T13:00:00.000Z",
        periodEnd: "2026-09-26T14:00:00.000Z",
        occurredAt: "2026-09-26T13:00:00.000Z",
      });
      expect("event" in parsed).toBe(true);
    }
  });

  it("pins committed HMAC test vectors", () => {
    for (const vector of readVectors().vectors) {
      expect(signBillingBody(vector.secret, vector.timestampSec, vector.body)).toBe(vector.signature);
      expect(
        verifyBillingBodySignature({
          rawBody: vector.body,
          now: Number(vector.timestampSec) * 1000,
          secret: vector.secret,
          signature: vector.signature,
          timestamp: vector.timestampSec,
        }).ok,
      ).toBe(true);
    }
  });

  it("isolates the deprecated nonce/body-hash MAC", () => {
    const body = '{"source":"eshobe-cms","events":[]}';
    const timestampMs = "1700000000000";
    const nonce = "abc123";
    const signature = signLegacyUsageBody({ body, nonce, secret: "legacy", timestampMs });
    expect(
      verifyLegacyUsageSignature({
        body,
        nonce,
        now: 1700000000000,
        secret: "legacy",
        signature,
        timestampMs,
      }).ok,
    ).toBe(true);
  });

  it("refuses an expired v1 signature", () => {
    const body = '{"events":[]}';
    const now = Date.parse("2026-09-26T13:00:00.000Z");
    const fresh = String(Math.floor(now / 1000));
    const signature = signBillingBody("secret", fresh, body);
    expect(
      verifyBillingBodySignature({ rawBody: body, now, secret: "secret", signature, timestamp: fresh }).ok,
    ).toBe(true);
    const stale = String(Math.floor((now - BILLING_REPLAY_WINDOW_MS - 1000) / 1000));
    const old = signBillingBody("secret", stale, body);
    expect(verifyBillingBodySignature({ rawBody: body, now, secret: "secret", signature: old, timestamp: stale }).ok).toBe(
      false,
    );
  });
});
