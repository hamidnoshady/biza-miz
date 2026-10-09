/**
 * Issue #866 — the taxpayer core, pinned by example. Every rule the register
 * depends on is asserted here with numbers small enough to check by hand:
 * exact allocation, the canonical payload hash, the idempotency key, the
 * reference number, the payload's blockers, the failure and inquiry policy, and
 * the tie-out to the sales ledger.
 */
import { describe, expect, it } from "vitest";
import {
  allocateProportionally,
  buildReferenceNumber,
  buildTaxPayload,
  canonicalJson,
  decideAfterInquiry,
  decideAfterSendFailure,
  deriveIdempotencyKey,
  hashPayload,
  newInvoiceUid,
  reconcileSales,
  TAX_PAYLOAD_VERSION,
  verifyPayloadHash,
  type ReconRecord,
  type ReconSource,
  type TaxBuildInput,
  type TaxSourceDocument,
} from "./tax-invoice-core";
import { TAX_UID_PATTERN } from "./tax-invoice";

const NOW = new Date("2026-10-09T08:00:00.000Z");
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const LOCATION = "0f3e1c2a-9b7d-4e1f-8a2b-000000000001";

describe("allocateProportionally", () => {
  it("splits exactly, giving the leftover Rial to the earlier line on a tie", () => {
    expect(allocateProportionally(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });

  it("gives the biggest remainder the extra Rial", () => {
    // Shares are 16.67, 33.33, 50: floors 16, 33, 50 leave one Rial, which goes to the 16.67.
    expect(allocateProportionally(100, [1, 2, 3])).toEqual([17, 33, 50]);
  });

  it("always sums to the amount, for any weights", () => {
    const weights = [7, 13, 0, 29, 1];
    for (const amount of [0, 1, 2, 999, 123456789]) {
      const parts = allocateProportionally(amount, weights);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(amount);
      expect(parts[2]).toBe(0);
    }
  });

  it("stays exact beyond 2^53 in the intermediate products", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const parts = allocateProportionally(max, [max, max]);
    expect(BigInt(parts[0]) + BigInt(parts[1])).toBe(BigInt(max));
    expect(parts[0] - parts[1]).toBe(1);
  });

  it("returns nothing for no weights and zeros for an empty amount over zero weights", () => {
    expect(allocateProportionally(0, [])).toEqual([]);
    expect(allocateProportionally(0, [0, 0])).toEqual([0, 0]);
  });

  it("refuses what it cannot split", () => {
    expect(() => allocateProportionally(5, [0, 0])).toThrow(RangeError);
    expect(() => allocateProportionally(-1, [1])).toThrow(RangeError);
    expect(() => allocateProportionally(1.5, [1])).toThrow(RangeError);
    expect(() => allocateProportionally(5, [-1, 2])).toThrow(RangeError);
  });
});

describe("canonical JSON and the payload hash", () => {
  it("sorts keys at every depth and drops undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 1 }, z: undefined })).toBe('{"a":{"c":1,"d":2},"b":1}');
  });

  it("hashes equal payloads to the same digest whatever order they were built in", () => {
    expect(hashPayload({ a: 1, b: [1, 2] })).toBe(hashPayload({ b: [1, 2], a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
    expect(hashPayload({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a fraction rather than hashing it differently on two machines", () => {
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(TypeError);
  });

  it("detects a stored snapshot that no longer matches its hash", () => {
    const snapshot = { totals: { totalRial: 327000 } };
    const hash = hashPayload(snapshot);
    expect(verifyPayloadHash(snapshot, hash)).toBe(true);
    expect(verifyPayloadHash({ totals: { totalRial: 327001 } }, hash)).toBe(false);
  });
});

describe("idempotency key", () => {
  const base = { businessId: BUSINESS, orderId: ORDER, kind: "sale" as const, revision: 1, parentSubmissionId: null };

  it("is the same for a retry of the same decision", () => {
    expect(deriveIdempotencyKey(base)).toBe(deriveIdempotencyKey({ ...base }));
    expect(deriveIdempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with each part of the decision", () => {
    const key = deriveIdempotencyKey(base);
    expect(deriveIdempotencyKey({ ...base, businessId: "33333333-3333-4333-8333-333333333333" })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...base, orderId: "44444444-4444-4444-8444-444444444444" })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...base, kind: "amendment" })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...base, revision: 2 })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...base, parentSubmissionId: "55555555-5555-4555-8555-555555555555" })).not.toBe(key);
  });

  it("gives every record a fresh authority uid, in the authority's shape", () => {
    const first = newInvoiceUid();
    expect(TAX_UID_PATTERN.test(first)).toBe(true);
    expect(newInvoiceUid()).not.toBe(first);
  });
});

describe("reference number", () => {
  it("reads prefix, unit, order number and kind letter with revision", () => {
    expect(
      buildReferenceNumber({ prefix: "BIZ", unitCode: "k1", locationId: LOCATION, orderNumber: 1042, kind: "sale", revision: 1 }),
    ).toBe("BIZ-K1-1042-S1");
  });

  it("falls back to the branch id when no unit code is set, so two branches' order 1042 stay apart", () => {
    expect(
      buildReferenceNumber({ prefix: "BIZ", unitCode: null, locationId: LOCATION, orderNumber: 1042, kind: "sale", revision: 1 }),
    ).toBe("BIZ-0F3E1C2A-1042-S1");
  });

  it("letters amendments and cancellations apart from sales", () => {
    const common = { prefix: "", unitCode: "U", locationId: LOCATION, orderNumber: 7 };
    expect(buildReferenceNumber({ ...common, kind: "amendment", revision: 2 })).toBe("U-7-A2");
    expect(buildReferenceNumber({ ...common, kind: "cancellation", revision: 1 })).toBe("U-7-C1");
  });

  it("refuses an order number that is not a positive integer, and a result the authority would not take", () => {
    expect(() => buildReferenceNumber({ prefix: "", unitCode: "U", locationId: LOCATION, orderNumber: 0, kind: "sale", revision: 1 })).toThrow(RangeError);
    expect(() => buildReferenceNumber({ prefix: "B I Z", unitCode: "U", locationId: LOCATION, orderNumber: 1, kind: "sale", revision: 1 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

function sourceFixture(overrides: Partial<TaxSourceDocument> = {}): TaxSourceDocument {
  return {
    orderId: ORDER,
    orderNumber: 1042,
    locationId: LOCATION,
    locationName: "شعبه مرکزی",
    orderStatus: "completed",
    closedAt: "2026-10-01T10:00:00.000Z",
    subtotalRial: 300000,
    discountRial: 0,
    serviceChargeRial: 0,
    vatRial: 27000,
    totalRial: 327000,
    buyer: { partyId: null, name: null, economicCode: null },
    lines: [
      { productKind: "menu_item", productId: "m1", name: "کباب", quantity: 2, unitPriceRial: 100000, modifiersRial: 0, taxCode: "1111111111111" },
      { productKind: "item", productId: "i1", name: "دوغ", quantity: 1, unitPriceRial: 100000, modifiersRial: 0, taxCode: "2222222222222" },
    ],
    ...overrides,
  };
}

function buildInput(overrides: Partial<TaxBuildInput> = {}): TaxBuildInput {
  return {
    kind: "sale",
    revision: 1,
    reference: "BIZ-K1-1042-S1",
    uid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    issuedAt: "2026-10-01T10:05:00.000Z",
    seller: {
      taxpayerId: "A1B2C3",
      taxpayerName: "شرکت نمونه",
      memoryId: "1234567890123456",
      unitCode: "K1",
      environment: "sandbox",
      submissionMode: "direct",
    },
    source: sourceFixture(),
    parent: null,
    reason: null,
    ...overrides,
  };
}

function blockerCodes(result: ReturnType<typeof buildTaxPayload>): string[] {
  if (result.ok) return [];
  return result.blockers.map((blocker) => blocker.code);
}

describe("buildTaxPayload: a complete sale", () => {
  it("allocates VAT exactly over the lines and reports the totals it was given", () => {
    const result = buildTaxPayload(buildInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.version).toBe(TAX_PAYLOAD_VERSION);
    // Bases 200000 and 100000; VAT 27000 splits 18000 and 9000 exactly.
    expect(result.payload.lines.map((line) => line.vatRial)).toEqual([18000, 9000]);
    expect(result.payload.lines.map((line) => line.totalRial)).toEqual([218000, 109000]);
    const lineTotal = result.payload.lines.reduce((sum, line) => sum + line.totalRial, 0);
    expect(lineTotal).toBe(result.payload.totals.totalRial);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPayloadHash(result.payload, result.hash)).toBe(true);
  });

  it("spreads a discount over the lines before it spreads the VAT", () => {
    const result = buildTaxPayload(
      buildInput({
        source: sourceFixture({ discountRial: 30000, vatRial: 24300, totalRial: 300000 - 30000 + 24300 }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.lines.map((line) => line.discountRial)).toEqual([20000, 10000]);
    expect(result.payload.lines.map((line) => line.taxableRial)).toEqual([180000, 90000]);
    // VAT is over the taxable amounts: 24300 splits 16200 and 8100.
    expect(result.payload.lines.map((line) => line.vatRial)).toEqual([16200, 8100]);
  });

  it("changes its hash when any stored figure changes", () => {
    const first = buildTaxPayload(buildInput());
    const second = buildTaxPayload(buildInput({ reference: "BIZ-K1-1042-S2" }));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.hash).not.toBe(first.hash);
  });

  it("builds an amendment that points at the accepted record it corrects", () => {
    const result = buildTaxPayload(
      buildInput({
        kind: "amendment",
        revision: 2,
        reference: "BIZ-K1-1042-A2",
        parent: { submissionId: "66666666-6666-4666-8666-666666666666", kind: "sale", uid: "uid-1", reference: "BIZ-K1-1042-S1", receiptId: "r-1" },
        reason: "اشتباه در تعداد",
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.parent?.reference).toBe("BIZ-K1-1042-S1");
      expect(result.payload.reason).toBe("اشتباه در تعداد");
    }
  });
});

describe("buildTaxPayload: refusals", () => {
  it("refuses a seller with no taxpayer id, and a branch with no memory", () => {
    const noTaxpayer = buildInput({ seller: { ...buildInput().seller, taxpayerId: "" } });
    expect(blockerCodes(buildTaxPayload(noTaxpayer))).toContain("profile_not_configured");
    const noMemory = buildInput({ seller: { ...buildInput().seller, memoryId: "" } });
    expect(blockerCodes(buildTaxPayload(noMemory))).toContain("unit_not_configured");
  });

  it("refuses an order that is not completed", () => {
    expect(blockerCodes(buildTaxPayload(buildInput({ source: sourceFixture({ orderStatus: "voided" }) })))).toContain("order_not_completed");
  });

  it("refuses an order with no lines", () => {
    expect(blockerCodes(buildTaxPayload(buildInput({ source: sourceFixture({ lines: [] }) })))).toContain("no_lines");
  });

  it("refuses a service charge, which this version does not report", () => {
    expect(blockerCodes(buildTaxPayload(buildInput({ source: sourceFixture({ serviceChargeRial: 1000 }) })))).toContain(
      "service_charge_unsupported",
    );
  });

  it("names each product without an item code once, however many lines it has", () => {
    const lines = [
      { productKind: "menu_item" as const, productId: "m9", name: "سالاد", quantity: 1, unitPriceRial: 100000, modifiersRial: 0, taxCode: null },
      { productKind: "menu_item" as const, productId: "m9", name: "سالاد", quantity: 1, unitPriceRial: 100000, modifiersRial: 0, taxCode: null },
    ];
    const result = buildTaxPayload(buildInput({ source: sourceFixture({ lines, subtotalRial: 200000, vatRial: 18000, totalRial: 218000 }) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const missing = result.blockers.filter((blocker) => blocker.code === "item_code_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].productId).toBe("m9");
    expect(missing[0].productName).toBe("سالاد");
  });

  it("refuses a totals row that disagrees with its own lines", () => {
    expect(blockerCodes(buildTaxPayload(buildInput({ source: sourceFixture({ subtotalRial: 300001, totalRial: 327001 }) })))).toContain(
      "totals_mismatch",
    );
    expect(blockerCodes(buildTaxPayload(buildInput({ source: sourceFixture({ totalRial: 327001 }) })))).toContain("totals_mismatch");
  });

  it("refuses a sale whose total is zero, but not a zero-valued correction", () => {
    const zeroLines = [{ productKind: "item" as const, productId: "i1", name: "نمونه", quantity: 1, unitPriceRial: 0, modifiersRial: 0, taxCode: "2222222222222" }];
    const zero = sourceFixture({ lines: zeroLines, subtotalRial: 0, vatRial: 0, totalRial: 0 });
    expect(blockerCodes(buildTaxPayload(buildInput({ source: zero })))).toContain("zero_total");
    expect(blockerCodes(buildTaxPayload(buildInput({ kind: "amendment", source: zero, parent: { submissionId: "s", kind: "sale", uid: "u", reference: "r", receiptId: null } })))).not.toContain(
      "zero_total",
    );
  });

  it("refuses a discount larger than the lines it is spread over", () => {
    // Total 0 is consistent with the sum, so only the discount rule can stop it.
    const source = sourceFixture({ discountRial: 310000, vatRial: 10000, totalRial: 0 });
    expect(blockerCodes(buildTaxPayload(buildInput({ source })))).toContain("invalid_amount");
  });

  it("refuses VAT on a base of nothing, where the allocation would have nowhere to put it", () => {
    const zeroLines = [{ productKind: "item" as const, productId: "i1", name: "نمونه", quantity: 1, unitPriceRial: 0, modifiersRial: 0, taxCode: "2222222222222" }];
    const source = sourceFixture({ lines: zeroLines, subtotalRial: 0, vatRial: 500, totalRial: 500 });
    expect(blockerCodes(buildTaxPayload(buildInput({ source })))).toContain("invalid_amount");
  });

  it("refuses a negative or fractional amount", () => {
    expect(blockerCodes(buildTaxPayload(buildInput({ source: sourceFixture({ subtotalRial: -1 }) })))).toContain("invalid_amount");
    expect(blockerCodes(buildTaxPayload(buildInput({ source: sourceFixture({ vatRial: 1.5 }) })))).toContain("invalid_amount");
  });

  it("returns every blocker at once rather than the first", () => {
    const result = buildTaxPayload(
      buildInput({
        seller: { ...buildInput().seller, taxpayerId: "", memoryId: "" },
        source: sourceFixture({ orderStatus: "voided", lines: [{ productKind: null, productId: null, name: "x", quantity: 1, unitPriceRial: 1, modifiersRial: 0, taxCode: null }] }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(blockerCodes(result)).toEqual(
      expect.arrayContaining(["profile_not_configured", "unit_not_configured", "order_not_completed", "item_code_missing"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Failures and what they do to a record
// ---------------------------------------------------------------------------

describe("decideAfterSendFailure", () => {
  it("queues a certain non-delivery for a retry after a backoff", () => {
    const decision = decideAfterSendFailure({ kind: "not_delivered", code: "connection_refused", message: "x" }, 0, NOW);
    expect(decision.status).toBe("queued");
    expect(decision.attempts).toBe(1);
    expect(decision.errorCode).toBe("connection_refused");
    expect(decision.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 10_000);
  });

  it("sends an ambiguous timeout to inquiry, never back to the queue", () => {
    const decision = decideAfterSendFailure({ kind: "unknown_delivery", code: "timeout", message: "x" }, 0, NOW);
    expect(decision.status).toBe("awaiting_inquiry");
    expect(decision.errorCode).toBe("timeout");
  });

  it("stops both transport failures after the attempt limit, with a reason an operator can act on", () => {
    for (const kind of ["not_delivered", "unknown_delivery"] as const) {
      const decision = decideAfterSendFailure({ kind, code: "timeout", message: "x" }, 7, NOW);
      expect(decision.status, kind).toBe("error");
      expect(decision.errorCode, kind).toBe("retries_exhausted");
      expect(decision.nextAttemptAt, kind).toBeNull();
    }
  });

  it("records a refusal as rejected with the authority's own issues", () => {
    const issues = [{ code: "item_code_invalid", message: "شناسه معتبر نیست", field: "lines[1].taxCode" }];
    const decision = decideAfterSendFailure({ kind: "rejected", issues }, 0, NOW);
    expect(decision.status).toBe("rejected");
    expect(decision.errorCode).toBe("provider_rejected");
    expect(decision.errorMessage).toBe("شناسه معتبر نیست");
    expect(decision.providerErrors).toEqual(issues);
    expect(decision.nextAttemptAt).toBeNull();
  });

  it("stops a permanent failure in error until an operator changes something", () => {
    const decision = decideAfterSendFailure({ kind: "permanent", code: "live_provider_unavailable", message: "x" }, 0, NOW);
    expect(decision.status).toBe("error");
    expect(decision.errorCode).toBe("live_provider_unavailable");
    expect(decision.nextAttemptAt).toBeNull();
  });
});

describe("decideAfterInquiry", () => {
  it("takes an accepted record to accepted and keeps the receipt", () => {
    const decision = decideAfterInquiry("submitted", { state: "accepted", receiptId: "r-1" }, 1, NOW);
    expect(decision.to).toBe("accepted");
    expect(decision.receiptId).toBe("r-1");
  });

  it("takes an accepted record out of inquiry too", () => {
    expect(decideAfterInquiry("awaiting_inquiry", { state: "accepted", receiptId: "r-2" }, 2, NOW).to).toBe("accepted");
  });

  it("takes a refused record to rejected with the issues", () => {
    const issues = [{ code: "parent_missing", message: "اصلاح باید به صورتحساب اشاره کند" }];
    const decision = decideAfterInquiry("submitted", { state: "rejected", issues }, 1, NOW);
    expect(decision.to).toBe("rejected");
    expect(decision.providerErrors).toEqual(issues);
  });

  it("keeps a processing record submitted and asks again later", () => {
    const decision = decideAfterInquiry("submitted", { state: "processing", receiptId: "r-3" }, 1, NOW);
    expect(decision.to).toBe("submitted");
    expect(decision.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("sends a record the authority never received back to the queue, now, to be resent under its uid", () => {
    const decision = decideAfterInquiry("awaiting_inquiry", { state: "not_found" }, 1, NOW);
    expect(decision.to).toBe("queued");
    expect(decision.errorCode).toBe("not_received");
    expect(decision.nextAttemptAt?.getTime()).toBe(NOW.getTime());
  });

  it("does not resend a submitted record that the authority cannot find; it watches it", () => {
    const decision = decideAfterInquiry("submitted", { state: "not_found" }, 1, NOW);
    expect(decision.to).toBe("awaiting_inquiry");
    expect(decision.errorCode).toBe("not_found");
  });

  it("keeps a record where it is when the authority cannot be reached", () => {
    expect(decideAfterInquiry("submitted", { state: "unreachable", code: "timeout", message: "x" }, 1, NOW).to).toBe("awaiting_inquiry");
    expect(decideAfterInquiry("awaiting_inquiry", { state: "unreachable", code: "timeout", message: "x" }, 1, NOW).to).toBe("awaiting_inquiry");
  });
});

// ---------------------------------------------------------------------------
// The tie-out to the sales ledger
// ---------------------------------------------------------------------------

const ORDER_B = "77777777-7777-4777-8777-777777777777";

function source(orderId: string, orderNumber: number, totalRial: number, vatRial: number, status = "completed"): ReconSource {
  return {
    orderId,
    orderNumber,
    locationId: LOCATION,
    locationName: "شعبه مرکزی",
    closedAt: "2026-10-01T10:00:00.000Z",
    status,
    totalRial,
    vatRial,
  };
}

function record(overrides: Partial<ReconRecord> & Pick<ReconRecord, "id" | "orderId" | "kind" | "revision" | "status">): ReconRecord {
  return { reference: `REF-${overrides.id}`, receiptId: null, vatRial: 27000, totalRial: 327000, ...overrides };
}

describe("reconcileSales", () => {
  it("accepts a sale whose accepted record carries the same totals", () => {
    const { rows, totals } = reconcileSales(
      [source(ORDER, 1, 327000, 27000)],
      [record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "accepted" })],
    );
    expect(rows[0].state).toBe("accepted");
    expect(totals.sourceCount).toBe(1);
    expect(totals.sourceTotalRial).toBe(327000);
    expect(totals.byState.accepted.count).toBe(1);
    expect(totals.differenceTotalRial).toBe(0);
  });

  it("flags an accepted record whose totals disagree with the sale, and measures the gap", () => {
    const { rows, totals } = reconcileSales(
      [source(ORDER, 1, 327000, 27000)],
      [record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "accepted", totalRial: 300000, vatRial: 0 })],
    );
    expect(rows[0].state).toBe("mismatch");
    expect(totals.differenceTotalRial).toBe(27000);
    expect(totals.differenceVatRial).toBe(27000);
  });

  it("reports a record still in flight as pending, and as a mismatch if it disagrees", () => {
    expect(
      reconcileSales([source(ORDER, 1, 327000, 27000)], [record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "awaiting_inquiry" })]).rows[0].state,
    ).toBe("pending");
    expect(
      reconcileSales([source(ORDER, 1, 327000, 27000)], [record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "submitted", totalRial: 1 })]).rows[0].state,
    ).toBe("mismatch");
  });

  it("reports an error record as error, not rejected", () => {
    expect(reconcileSales([source(ORDER, 1, 327000, 27000)], [record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "error" })]).rows[0].state).toBe(
      "error",
    );
  });

  it("reports a refused sale with nothing live standing as rejected", () => {
    expect(reconcileSales([source(ORDER, 1, 327000, 27000)], [record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "rejected" })]).rows[0].state).toBe(
      "rejected",
    );
  });

  it("counts a completed sale that no record reports as missing, with its amounts", () => {
    const { rows, totals } = reconcileSales([source(ORDER, 1, 327000, 27000)], []);
    expect(rows[0].state).toBe("missing");
    expect(totals.unrecordedTotalRial).toBe(327000);
    expect(totals.unrecordedVatRial).toBe(27000);
  });

  it("keeps a voided sale out of the totals, unless a live record still stands for it", () => {
    const quiet = reconcileSales([source(ORDER, 1, 327000, 27000, "voided")], []);
    expect(quiet.rows[0].state).toBe("voided");
    expect(quiet.totals.sourceCount).toBe(0);
    expect(quiet.totals.byState.voided.count).toBe(1);

    const loud = reconcileSales(
      [source(ORDER, 1, 327000, 27000, "voided")],
      [record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "accepted" })],
    );
    expect(loud.rows[0].state).toBe("mismatch");
    expect(loud.totals.differenceTotalRial).toBe(-327000);
  });

  it("shows a sale as cancelled once its cancellation is accepted, not as accepted", () => {
    // Regression: an accepted cancellation record used to stand in for the sale.
    const { rows } = reconcileSales(
      [source(ORDER, 1, 327000, 27000)],
      [
        record({ id: "s", orderId: ORDER, kind: "sale", revision: 1, status: "cancelled" }),
        record({ id: "c", orderId: ORDER, kind: "cancellation", revision: 1, status: "accepted" }),
      ],
    );
    expect(rows[0].state).toBe("cancelled");
  });

  it("keeps a sale accepted while its cancellation is still in flight", () => {
    const { rows } = reconcileSales(
      [source(ORDER, 1, 327000, 27000)],
      [
        record({ id: "s", orderId: ORDER, kind: "sale", revision: 1, status: "accepted" }),
        record({ id: "c", orderId: ORDER, kind: "cancellation", revision: 1, status: "submitted" }),
      ],
    );
    expect(rows[0].state).toBe("accepted");
  });

  it("lets an accepted amendment stand for the sale in place of the original", () => {
    const { rows } = reconcileSales(
      [source(ORDER, 1, 327000, 27000)],
      [
        record({ id: "s", orderId: ORDER, kind: "sale", revision: 1, status: "accepted", totalRial: 300000, vatRial: 0 }),
        record({ id: "a", orderId: ORDER, kind: "amendment", revision: 1, status: "accepted" }),
      ],
    );
    expect(rows[0].state).toBe("accepted");
    expect(rows[0].recordId).toBe("a");
  });

  it("reads the latest revision of a resubmitted sale", () => {
    const { rows } = reconcileSales(
      [source(ORDER, 1, 327000, 27000)],
      [
        record({ id: "old", orderId: ORDER, kind: "sale", revision: 1, status: "rejected" }),
        record({ id: "new", orderId: ORDER, kind: "sale", revision: 2, status: "accepted" }),
      ],
    );
    expect(rows[0].state).toBe("accepted");
    expect(rows[0].recordId).toBe("new");
  });

  it("ignores records that belong to other sales, and sums each state separately", () => {
    const { rows, totals } = reconcileSales(
      [source(ORDER, 1, 327000, 27000), source(ORDER_B, 2, 100000, 0)],
      [
        record({ id: "a", orderId: ORDER, kind: "sale", revision: 1, status: "accepted" }),
        record({ id: "z", orderId: "99999999-9999-4999-8999-999999999999", kind: "sale", revision: 1, status: "accepted" }),
      ],
    );
    expect(rows.map((row) => row.state)).toEqual(["accepted", "missing"]);
    expect(totals.sourceCount).toBe(2);
    expect(totals.sourceTotalRial).toBe(427000);
    expect(totals.sourceVatRial).toBe(27000);
    expect(totals.byState.accepted.totalRial).toBe(327000);
    expect(totals.byState.missing.totalRial).toBe(100000);
  });
});
