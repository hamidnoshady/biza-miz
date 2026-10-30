import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SMS_FIRST_SEGMENT_CHARS, SMS_NEXT_SEGMENT_CHARS, smsSegmentCount } from "../messaging-billing-pure";
import {
  EMPTY_CAMPAIGN_DEMAND,
  PENDING_OUTBOX_STATES,
  priceCampaignDemand,
  smsSegmentsSql,
} from "./campaign-demand";

/**
 * Issue #902 §9 item 1 — funding sized by the approved queue, not only by the
 * policy buffer. The planner's arithmetic is tested in `pricing-service.test.ts`;
 * what is checked here is the *unit* the demand is counted in, because that is
 * where a quiet error would hide: a per-recipient count under-funds every
 * multipart campaign by a factor of two or three and looks perfectly plausible
 * on a dashboard.
 */

const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("campaign demand is counted in the unit the provider bills", () => {
  it("prices segments, not recipients", () => {
    const demand = priceCampaignDemand({
      messages: 2,
      segments: 5,
      campaigns: 1,
      perSegmentRial: 2_070,
    });
    expect(demand).toMatchObject({
      messages: 2,
      segments: 5,
      campaigns: 1,
      // 2 × 2,070 would be a 60% under-estimate for these two bodies.
      estimatedWholesaleRial: 5 * 2_070,
    });
  });

  it("is zero for an empty queue, and never negative", () => {
    expect(priceCampaignDemand({ messages: 0, segments: 0, campaigns: 0, perSegmentRial: 900 })).toEqual(
      EMPTY_CAMPAIGN_DEMAND,
    );
    expect(
      priceCampaignDemand({ messages: -3, segments: -4, campaigns: -1, perSegmentRial: -5 }),
    ).toEqual(EMPTY_CAMPAIGN_DEMAND);
  });

  it("moves with the tariff, and prices nothing when there is none", () => {
    expect(
      priceCampaignDemand({ messages: 1, segments: 3, campaigns: 1, perSegmentRial: 0 })
        .estimatedWholesaleRial,
    ).toBe(0);
    expect(
      priceCampaignDemand({ messages: 1, segments: 3, campaigns: 1, perSegmentRial: 900 })
        .estimatedWholesaleRial,
    ).toBe(2_700);
  });

  it("only counts work that still owes the provider a call", () => {
    expect([...PENDING_OUTBOX_STATES]).toEqual(["queued", "sending"]);
    // `sent`, `delivered` and `failed` are all settled questions; counting them
    // would make the target grow forever on the history of a busy business.
    expect(PENDING_OUTBOX_STATES).not.toContain("delivered");
    expect(PENDING_OUTBOX_STATES).not.toContain("failed");
  });
});

describe("the SQL segment rule is the billing rule", () => {
  it("is built from the billing constants rather than literals", () => {
    const sql = smsSegmentsSql("r.body");
    expect(sql).toContain(`<= ${SMS_FIRST_SEGMENT_CHARS}`);
    expect(sql).toContain(`- ${SMS_FIRST_SEGMENT_CHARS}`);
    expect(sql).toContain(`/ ${SMS_NEXT_SEGMENT_CHARS}`);
    expect(sql).toContain("r.body");
  });

  it("reproduces smsSegmentCount for the boundary bodies", () => {
    // The expression, evaluated as JS over the same numbers the SQL uses.
    const segments = (chars: number) =>
      chars <= SMS_FIRST_SEGMENT_CHARS
        ? 1
        : 1 + Math.ceil((chars - SMS_FIRST_SEGMENT_CHARS) / SMS_NEXT_SEGMENT_CHARS);

    for (const chars of [0, 1, 70, 71, 137, 138, 205, 500]) {
      expect(segments(chars)).toBe(smsSegmentCount("x".repeat(chars)));
    }
    // A Persian body is UCS-2 code units, which is what `LENGTH()` counts in
    // PostgreSQL for a `text` column, so the two units agree.
    expect(smsSegmentCount("کد ورود شما: ۱۲۳۴")).toBe(1);
  });

  it("refuses anything that is not a column reference", () => {
    // The expression is interpolated into a query string, so the only thing
    // standing between an accident and an injection is this check.
    expect(() => smsSegmentsSql("r.body); DROP TABLE message_outbox; --")).toThrow(/non-column/);
    expect(() => smsSegmentsSql("")).toThrow();
    expect(smsSegmentsSql("body")).toContain("body");
  });
});

describe("where the demand is read", () => {
  it("is read in the funding transaction, for the child being planned", () => {
    const pricing = read("src/lib/kavenegar/pricing-service.ts");
    // Inside the reservation, not in a separate pass: the decision has to be
    // made against the queue as it exists at the moment of the decision.
    const reservation = pricing.slice(
      pricing.indexOf("export async function reserveAutomaticTransfer"),
      pricing.indexOf("export async function fundManagedChild"),
    );
    expect(reservation).toMatch(
      /readPendingCampaignDemand\(input\.businessId, conservativePerSegment\(snapshot\.tariff\)\)/,
    );
    expect(reservation).toMatch(/pendingDemandRial: demand\.estimatedWholesaleRial/);

    // Scoped to one business: a fleet-wide sum would let one tenant's campaign
    // fund another tenant's child.
    const reader = pricing.slice(pricing.indexOf("export async function readPendingCampaignDemand"));
    expect(reader).toMatch(/WHERE o\.business_id = \$1/);
    expect(reader).toMatch(/o\.channel = 'sms'/);
    expect(reader).toMatch(/smsSegmentsSql\("r\.body"\)/);
  });
});
