import { describe, expect, it, vi } from "vitest";
import { MoodianTaxProvider, type MoodianCodec } from "./tax-invoice-moodian";
import { installVerifiedMoodianCodec, type TaxSubmitRequest } from "./tax-invoice-provider";
import type { TaxPayloadV1 } from "./tax-invoice-core";

const uid = "11111111-1111-4111-8111-111111111111";
const payload = { seller: { memoryId: "FISCAL", submissionMode: "tsp" } } as TaxPayloadV1;
const request: TaxSubmitRequest = { uid, reference: "INTERNAL", payload, environment: "production", credentials: { tspUsername: "TRUSTED-PROVIDER" }, retry: true };
const codec: MoodianCodec = {
  verificationReference: "unit-test-fixtures-only-NOT-authority-approval",
  invoice: async (req) => ({ uid: req.uid, fiscalId: "FISCAL", packetType: "INVOICE.V01", retry: Boolean(req.retry), data: "encrypted", dataSignature: "sig", encryptionKeyId: "k", symmetricKey: "s", iv: "iv" }),
  sign: async () => ({ signature: "signed-test-only", signatureKeyId: "test-key" }),
  verifyResponse: async () => true,
};
function replies() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result: { data: { token: "TOKEN", expiresIn: 60 } } })).mockResolvedValueOnce(Response.json({ result: [{ uid, referenceNumber: "RECEIPT" }] }));
}
describe("gated Moodian transport", () => {
  it("has no implicit signer or activation from an env flag", async () => {
    const fetcher = replies();
    await expect(new MoodianTaxProvider({ fetch: fetcher }).submit(request)).rejects.toMatchObject({ failure: { kind: "permanent", code: "live_provider_unavailable" } });
    await expect(new MoodianTaxProvider({ enabled: true, fetch: fetcher }).submit(request)).rejects.toMatchObject({ failure: { kind: "permanent" } });
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("TAX_MOODIAN_TRANSPORT_ENABLED", "false");
    expect(() => installVerifiedMoodianCodec(codec)).toThrow("moodian_transport_not_approved");
    vi.unstubAllEnvs();
  });
  it("uses TSP GET_TOKEN then normal-enqueue with the same uid and retry flag", async () => {
    const fetcher = replies();
    expect(await new MoodianTaxProvider({ enabled: true, codec, fetch: fetcher }).submit(request)).toEqual({ receiptId: "RECEIPT" });
    expect(fetcher.mock.calls[0][0]).toBe("https://tp.tax.gov.ir/req/api/tsp/sync/GET_TOKEN");
    const first = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(first.packet.data.username).toBe("TRUSTED-PROVIDER");
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe("https://tp.tax.gov.ir/req/api/tsp/async/normal-enqueue");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer TOKEN", requestTraceId: expect.any(String), timestamp: expect.any(String) });
    expect(JSON.parse(String(init?.body)).packets[0]).toMatchObject({ uid, retry: true, fiscalId: "FISCAL" });
  });
  it("uses memory identity for direct authentication", async () => {
    const fetcher = replies();
    await new MoodianTaxProvider({ enabled: true, codec, fetch: fetcher }).submit({ ...request, payload: { ...payload, seller: { ...payload.seller, submissionMode: "direct" } } });
    expect(fetcher.mock.calls[0][0]).toBe("https://tp.tax.gov.ir/req/api/self-tsp/sync/GET_TOKEN");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).packet.data.username).toBe("FISCAL");
  });
  it("never blindly resends after a network failure or unverifiable invoice response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("timeout"));
    await expect(new MoodianTaxProvider({ enabled: true, codec, fetch: fetcher }).submit(request)).rejects.toMatchObject({ failure: { kind: "not_delivered" } });
    const sendTimeout = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result: { data: { token: "TOKEN", expiresIn: 60 } } })).mockRejectedValueOnce(new Error("timeout"));
    await expect(new MoodianTaxProvider({ enabled: true, codec, fetch: sendTimeout }).submit(request)).rejects.toMatchObject({ failure: { kind: "unknown_delivery" } });
  });
  it("requires response verification and keeps missing inquiry rows unreachable, not not_found", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result: { data: { token: "TOKEN", expiresIn: 60 } } })).mockResolvedValueOnce(Response.json({ result: { data: [] } }));
    const provider = new MoodianTaxProvider({ enabled: true, codec, fetch: fetcher });
    expect(await provider.inquire({ uid, reference: "x", receiptId: null, environment: "production", memoryId: "FISCAL", submissionMode: "tsp", credentials: request.credentials })).toMatchObject({ state: "unreachable", code: "inquiry_incomplete" });
    const unverified = new MoodianTaxProvider({ enabled: true, codec: { ...codec, verifyResponse: async () => false }, fetch: replies() });
    await expect(unverified.submit(request)).rejects.toMatchObject({ failure: { kind: "not_delivered" } });
  });
  it("does not accept a tenant-controlled endpoint or an unsigned invoice packet", async () => {
    expect(() => new MoodianTaxProvider({ baseUrl: "https://127.0.0.1/" })).toThrow("moodian_endpoint_not_allowlisted");
    const fetcher = replies();
    const unsigned: MoodianCodec = { ...codec, invoice: async (req) => ({ ...await codec.invoice(req), dataSignature: "" }) };
    await expect(new MoodianTaxProvider({ enabled: true, codec: unsigned, fetch: fetcher }).submit(request)).rejects.toMatchObject({ failure: { code: "invoice_codec_unverified" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
