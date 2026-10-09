/**
 * Issue #866 — the provider boundary. The simulator stands in for the authority in
 * development and tests, so the behaviours the worker depends on are pinned here:
 * the uid deduplication, what a timeout leaves behind, and the production
 * adapter's refusal to send anything it cannot yet deliver correctly.
 */
import { describe, expect, it } from "vitest";
import { buildTaxPayload, type TaxPayloadV1 } from "./tax-invoice-core";
import { providerFor, sandboxProvider, SandboxTaxProvider, TaxProviderFailure } from "./tax-invoice-provider";

const UID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UID_2 = "4a2504e0-4f89-41d3-9a0c-0305e82c3302";
const LOCATION = "0f3e1c2a-9b7d-4e1f-8a2b-000000000001";

function salePayload(uid = UID): TaxPayloadV1 {
  const result = buildTaxPayload({
    kind: "sale",
    revision: 1,
    reference: "BIZ-K1-1042-S1",
    uid,
    issuedAt: "2026-10-01T10:05:00.000Z",
    seller: { taxpayerId: "A1B2C3", taxpayerName: "شرکت نمونه", memoryId: "1234567890123456", unitCode: "K1", environment: "sandbox", submissionMode: "direct" },
    source: {
      orderId: "22222222-2222-4222-8222-222222222222",
      orderNumber: 1042,
      locationId: LOCATION,
      locationName: "شعبه مرکزی",
      orderStatus: "completed",
      closedAt: "2026-10-01T10:00:00.000Z",
      subtotalRial: 100000,
      discountRial: 0,
      serviceChargeRial: 0,
      vatRial: 9000,
      totalRial: 109000,
      buyer: { partyId: null, name: null, economicCode: null },
      lines: [{ productKind: "item", productId: "i1", name: "دوغ", quantity: 1, unitPriceRial: 100000, modifiersRial: 0, taxCode: "2222222222222" }],
    },
    parent: null,
    reason: null,
  });
  if (!result.ok) throw new Error("fixture must build");
  return result.payload;
}

function amendmentWithoutParent(): TaxPayloadV1 {
  return { ...salePayload(), kind: "amendment", revision: 2, reference: "BIZ-K1-1042-A2", parent: null };
}

const request = (payload: TaxPayloadV1, uid = UID) => ({
  uid,
  reference: payload.reference,
  environment: "sandbox" as const,
  payload,
  credentials: null,
});

describe("sandbox submit: uid deduplication", () => {
  it("holds a new packet and returns a receipt", async () => {
    const provider = new SandboxTaxProvider();
    const { receiptId } = await provider.submit(request(salePayload()));
    expect(receiptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(provider.packetCount).toBe(1);
  });

  it("returns the same receipt for a resend under a known uid and holds nothing new", async () => {
    const provider = new SandboxTaxProvider();
    const first = await provider.submit(request(salePayload()));
    const again = await provider.submit(request(salePayload()));
    expect(again.receiptId).toBe(first.receiptId);
    expect(provider.packetCount).toBe(1);
  });

  it("keeps distinct uids as distinct packets", async () => {
    const provider = new SandboxTaxProvider();
    await provider.submit(request(salePayload(UID)));
    await provider.submit(request(salePayload(UID_2), UID_2));
    expect(provider.packetCount).toBe(2);
  });
});

describe("sandbox submit: what each failure leaves behind", () => {
  it("holds nothing for a packet that certainly did not arrive, and accepts the resend", async () => {
    const provider = new SandboxTaxProvider({
      submitFailures: [{ kind: "not_delivered", code: "connection_refused", message: "رد اتصال" }],
    });
    await expect(provider.submit(request(salePayload()))).rejects.toMatchObject({
      failure: { kind: "not_delivered", code: "connection_refused" },
    });
    expect(provider.packetCount).toBe(0);

    await provider.submit(request(salePayload()));
    expect(provider.packetCount).toBe(1);
  });

  it("holds the packet for an ambiguous timeout, so an inquiry can find it", async () => {
    const provider = new SandboxTaxProvider({
      submitFailures: [{ kind: "unknown_delivery", code: "timeout", message: "مهلت" }],
      processingPolls: 0,
    });
    const error = await provider.submit(request(salePayload())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaxProviderFailure);
    expect(provider.packetCount).toBe(1);
    expect(await provider.inquire({ uid: UID, reference: "x", receiptId: null, environment: "sandbox", credentials: null })).toMatchObject({
      state: "accepted",
    });
  });

  it("refuses a packet as rejected only when the failure says the authority read it", async () => {
    const provider = new SandboxTaxProvider({
      submitFailures: [{ kind: "rejected", issues: [{ code: "x", message: "y" }] }],
    });
    await expect(provider.submit(request(salePayload()))).rejects.toMatchObject({ failure: { kind: "rejected" } });
  });
});

describe("sandbox inquiry", () => {
  const inquiry = (uid = UID) => ({ uid, reference: "BIZ-K1-1042-S1", receiptId: null, environment: "sandbox" as const, credentials: null });

  it("reports not found for a uid the authority never received", async () => {
    expect(await new SandboxTaxProvider().inquire(inquiry(UID_2))).toEqual({ state: "not_found" });
  });

  it("reports processing for the configured polls, then the receipt", async () => {
    const provider = new SandboxTaxProvider({ processingPolls: 2 });
    const { receiptId } = await provider.submit(request(salePayload()));
    expect(await provider.inquire(inquiry())).toMatchObject({ state: "processing", receiptId });
    expect(await provider.inquire(inquiry())).toMatchObject({ state: "processing", receiptId });
    expect(await provider.inquire(inquiry())).toEqual({ state: "accepted", receiptId });
  });

  it("reports a rejection for an amendment that names no parent", async () => {
    const provider = new SandboxTaxProvider({ processingPolls: 0 });
    await provider.submit(request(amendmentWithoutParent()));
    const outcome = await provider.inquire(inquiry());
    expect(outcome.state).toBe("rejected");
    if (outcome.state === "rejected") expect(outcome.issues.map((issue) => issue.code)).toContain("parent_missing");
  });

  it("reports a rejection for a line whose item code is not thirteen digits", async () => {
    const provider = new SandboxTaxProvider({ processingPolls: 0 });
    const payload = salePayload();
    const broken: TaxPayloadV1 = { ...payload, lines: payload.lines.map((line) => ({ ...line, taxCode: "123" })) };
    await provider.submit(request(broken));
    const outcome = await provider.inquire(inquiry());
    expect(outcome.state === "rejected" && outcome.issues.map((issue) => issue.code)).toEqual(["item_code_invalid"]);
  });

  it("returns the scripted outcomes first, in order, before its own answer", async () => {
    const provider = new SandboxTaxProvider({
      inquiryOutcomes: [{ state: "unreachable", code: "timeout", message: "مهلت" }],
      processingPolls: 0,
    });
    await provider.submit(request(salePayload()));
    expect(await provider.inquire(inquiry())).toEqual({ state: "unreachable", code: "timeout", message: "مهلت" });
    expect((await provider.inquire(inquiry())).state).toBe("accepted");
  });
});

describe("provider selection", () => {
  it("serves the sandbox from one shared simulator, so the simulated authority outlives a tick", () => {
    expect(providerFor("sandbox")).toBe(sandboxProvider());
    expect(sandboxProvider()).toBe(sandboxProvider());
  });

  it("never sends a production record to the simulator", async () => {
    const live = providerFor("production");
    expect(live).not.toBe(sandboxProvider());
    expect(live.provider).toBe("moodian");
  });

  it("fails a production submit permanently, with a message the operator can act on, and sends nothing", async () => {
    const live = providerFor("production");
    const error = await live.submit(request(salePayload())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaxProviderFailure);
    expect((error as TaxProviderFailure).failure).toMatchObject({ kind: "permanent", code: "live_provider_unavailable" });
  });

  it("reports a production inquiry as unreachable rather than as not found, so no resend follows", async () => {
    expect(await providerFor("production").inquire({ uid: UID, reference: "x", receiptId: null, environment: "production", credentials: null })).toEqual({
      state: "unreachable",
      code: "live_provider_unavailable",
      message: "استعلام زنده از سامانه مودیان هنوز فعال نشده است.",
    });
  });
});
