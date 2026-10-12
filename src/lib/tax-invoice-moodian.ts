/**
 * Public-documentation transport, NOT a production-ready signer.
 * Source: https://rahrokh.com/technical-instructions-on-how-to-connect-to-modian-system-2/
 * GET_TOKEN, async/normal-enqueue, INQUIRY_BY_UID; packet/result names from tables 3–11.
 * A reviewed codec must supply signing, encryption, taxid/pattern mapping and response verification.
 * No default codec exists. Nothing in the application enables this transport by default.
 */
import { randomUUID } from "node:crypto";
import { TaxProviderFailure, type TaxCredentials, type TaxInquiryRequest, type TaxProviderAdapter, type TaxSubmitRequest } from "./tax-invoice-provider";
import type { InquiryOutcome, ProviderIssue } from "./tax-invoice-core";

export interface MoodianPacket {
  uid: string | null;
  packetType: string;
  retry: boolean;
  data: unknown;
  fiscalId: string;
  encryptionKeyId: string;
  symmetricKey: string;
  iv: string;
  dataSignature: string;
}
export interface MoodianCodec {
  /** Operator-reviewed spec/SDK version, not an automatic claim of conformance. */
  verificationReference: string;
  invoice(request: TaxSubmitRequest): Promise<MoodianPacket>;
  sign(body: unknown, headers: { requestTraceId: string; timestamp: string }, credentials: TaxCredentials | null): Promise<{ signature: string; signatureKeyId: string | null }>;
  verifyResponse(raw: string, headers: Headers): Promise<boolean>;
}
export interface MoodianTransportOptions {
  enabled?: boolean;
  codec?: MoodianCodec;
  fetch?: typeof fetch;
  /** Fixed authority URL; never supplied by tenant settings (SSRF). */
  baseUrl?: string;
  timeoutMs?: number;
}

export class MoodianTaxProvider implements TaxProviderAdapter {
  readonly provider = "moodian" as const;
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  private readonly timeout: number;
  constructor(private readonly options: MoodianTransportOptions = {}) {
    this.base = options.baseUrl ?? "https://tp.tax.gov.ir/req/api/";
    if (this.base !== "https://tp.tax.gov.ir/req/api/") throw new Error("moodian_endpoint_not_allowlisted");
    this.fetcher = options.fetch ?? fetch;
    this.timeout = Math.min(Math.max(options.timeoutMs ?? 15000, 100), 30000);
  }
  private codec(): MoodianCodec {
    if (!this.options.enabled || !this.options.codec?.verificationReference.trim()) {
      throw new TaxProviderFailure({ kind: "permanent", code: "live_provider_unavailable", message: "ارسال زنده تا تأیید امضا، رمزگذاری و الگو فعال نمی‌شود." });
    }
    return this.options.codec;
  }
  private packet(type: string, data: unknown, fiscalId: string): MoodianPacket {
    return { uid: null, packetType: type, retry: false, data, fiscalId, encryptionKeyId: "", symmetricKey: "", iv: "", dataSignature: "" };
  }
  private async post(mode: "direct" | "tsp", path: string, body: unknown, credentials: TaxCredentials | null, token: string | null, delivery: boolean): Promise<Record<string, unknown>> {
    const codec = this.codec();
    const headers = { requestTraceId: randomUUID(), timestamp: String(Date.now()) };
    const signed = { ...body as Record<string, unknown>, ...await codec.sign(body, headers, credentials) };
    if (!signed.signature) throw new TaxProviderFailure({ kind: "permanent", code: "signing_unverified", message: "امضای درخواست آماده نیست." });
    try {
      const response = await this.fetcher(`${this.base}${mode === "tsp" ? "tsp" : "self-tsp"}/${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeout),
        headers: { ...headers, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(signed),
      });
      // Bound the response while streaming. Never read an unbounded authority/proxy body.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("empty_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) { await reader.cancel(); throw new Error("response_too_large"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!response.ok || !await codec.verifyResponse(raw, response.headers)) throw new Error("unverified_response");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_response");
      return parsed as Record<string, unknown>;
    } catch {
      // Every failure after the invoice POST might have delivered it, including HTTP 5xx and bad signatures.
      throw new TaxProviderFailure({ kind: delivery ? "unknown_delivery" : "not_delivered", code: "moodian_transport_unavailable", message: "پاسخ معتبر سامانه دریافت نشد؛ استعلام لازم است." });
    }
  }
  private async token(mode: "direct" | "tsp", memoryId: string, credentials: TaxCredentials | null): Promise<string> {
    const username = mode === "tsp" ? credentials?.tspUsername : memoryId;
    if (!username?.trim()) throw new TaxProviderFailure({ kind: "permanent", code: "tsp_username_required", message: "شناسه شرکت معتمد لازم است." });
    const response = await this.post(mode, "sync/GET_TOKEN", { time: 1, packet: this.packet("GET_TOKEN", { username }, "") }, credentials, null, false);
    const result = response.result as { data?: { token?: unknown; expiresIn?: unknown } } | undefined;
    const token = result?.data?.token;
    const expires = result?.data?.expiresIn;
    if (typeof token !== "string" || token.length < 1 || token.length > 16000 || typeof expires !== "number" || expires <= 0) {
      throw new TaxProviderFailure({ kind: "permanent", code: "invalid_token_response", message: "توکن معتبر دریافت نشد." });
    }
    // No process-wide token cache: credentials and tenant identities never cross calls.
    return token;
  }
  async submit(request: TaxSubmitRequest): Promise<{ receiptId: string }> {
    const codec = this.codec();
    const mode = request.payload.seller.submissionMode;
    const memoryId = request.payload.seller.memoryId;
    const packet = await codec.invoice(request);
    if (packet.uid !== request.uid || packet.fiscalId !== memoryId || packet.retry !== Boolean(request.retry) || !/^INVOICE\.V\d{2}$/.test(packet.packetType)
      || typeof packet.data !== "string" || !packet.data || !packet.dataSignature || !packet.encryptionKeyId || !packet.symmetricKey || !packet.iv) {
      throw new TaxProviderFailure({ kind: "permanent", code: "invoice_codec_unverified", message: "بستهٔ امضاشده و رمزگذاری‌شده معتبر نیست." });
    }
    const token = await this.token(mode, memoryId, request.credentials);
    const response = await this.post(mode, "async/normal-enqueue", { packets: [packet] }, request.credentials, token, true);
    const result = Array.isArray(response.result) ? response.result.find((item) => item?.uid === request.uid) : null;
    if (!result || typeof result.referenceNumber !== "string" || !result.referenceNumber || result.referenceNumber.length > 128 || result.errorCode) {
      // Do not guess that a malformed or undocumented refusal means no invoice exists.
      throw new TaxProviderFailure({ kind: "unknown_delivery", code: "invalid_submit_response", message: "رسید معتبر دریافت نشد؛ فقط استعلام انجام شود." });
    }
    return { receiptId: result.referenceNumber };
  }
  async inquire(request: TaxInquiryRequest): Promise<InquiryOutcome> {
    try {
      this.codec();
      const mode = request.submissionMode ?? "direct";
      const memoryId = request.memoryId;
      if (!memoryId) return { state: "unreachable", code: "memory_required", message: "شناسه حافظه در رکورد موجود نیست." };
      const token = await this.token(mode, memoryId, request.credentials);
      const response = await this.post(mode, "sync/INQUIRY_BY_UID", { time: 1, packet: this.packet("INQUIRY_BY_UID", { uid: [{ uid: request.uid, fiscalId: memoryId }] }, memoryId) }, request.credentials, token, false);
      const result = response.result as { data?: unknown } | undefined;
      const items = result?.data;
      const row = Array.isArray(items) ? items.find((item) => item?.uid === request.uid && item?.fiscalId === memoryId) : null;
      if (!row) return { state: "unreachable", code: "inquiry_incomplete", message: "نبود ردیف نتیجه، اثبات عدم دریافت نیست." };
      if (typeof row.referenceNumber !== "string" || !row.referenceNumber || row.referenceNumber.length > 128 || (request.receiptId && request.receiptId !== row.referenceNumber)) return { state: "unreachable", code: "receipt_conflict", message: "رسید نتیجه سازگار نیست." };
      if (row.status === "SUCCESS") return { state: "accepted", receiptId: row.referenceNumber };
      if (row.status === "PENDING" || row.status === "IN_PROGRESS") return { state: "processing", receiptId: row.referenceNumber };
      if (row.status === "FAILED") {
        const issues = row.data?.error;
        if (Array.isArray(issues) && issues.length > 0 && issues.length <= 100 && issues.every((item) => typeof item?.code === "string" && typeof item?.message === "string")) {
          return { state: "rejected", issues: issues.map((item): ProviderIssue => ({ code: item.code, message: item.message })) };
        }
      }
      return { state: "unreachable", code: "inquiry_unverified", message: "نتیجهٔ استعلام شناخته‌شده نیست." };
    } catch { return { state: "unreachable", code: "live_provider_unavailable", message: "استعلام زنده تا تأیید پروتکل فعال نمی‌شود." }; }
  }
}
