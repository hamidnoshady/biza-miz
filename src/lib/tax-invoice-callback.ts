/** Platform/TSP callback v1. This is NOT a claim about Moodian's official callback protocol. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { query, withTenantTransaction } from "./db";
import { decryptSecret, resolveEncryptionKey } from "./integrations/secrets";
import { decideAfterInquiry, type InquiryOutcome, type ProviderIssue } from "./tax-invoice-core";
import { TaxServiceError, taxLog } from "./tax-invoice-service";
import type { TaxKind, TaxStatus } from "./tax-invoice";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY = 65536;

/** Bound actual bytes, not just Content-Length (which a client can omit or lie about). */
export async function readTaxCallbackBody(request: Request): Promise<string> {
  if (!request.body) throw new TaxServiceError("invalid_body", 400, "بدنه نامعتبر است.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new TaxServiceError("body_too_large", 413, "بدنه بیش از حد بزرگ است.");
      }
      chunks.push(value);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new TaxServiceError("invalid_body", 400, "بدنه باید UTF-8 معتبر باشد."); }
  } finally { reader.releaseLock(); }
}

/** HMAC-SHA256 hex over timestamp + newline + URL tenant + newline + exact UTF-8 body. */
export function verifyTaxCallbackSignature(businessId: string, raw: string, timestamp: string | null, signature: string | null, secret: string | undefined, now = new Date()): boolean {
  if (!secret || secret.length < 32 || !timestamp || !/^\d{13}$/.test(timestamp) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now.getTime() - Number(timestamp)) > 300000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${businessId}\n${raw}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

interface Callback { eventId: string; uid: string; provider: "sandbox" | "moodian"; outcome: InquiryOutcome }
function parseCallback(raw: string): Callback {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { throw new TaxServiceError("invalid_body", 400, "بدنه نامعتبر است."); }
  if (!body || typeof body !== "object" || typeof body.eventId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.eventId)
    || typeof body.uid !== "string" || !UUID.test(body.uid) || !["sandbox", "moodian"].includes(String(body.provider))) {
    throw new TaxServiceError("invalid_callback", 400, "پیام استعلام نامعتبر است.");
  }
  const status = body.status;
  let outcome: InquiryOutcome;
  if (status === "accepted" || status === "processing") {
    if (typeof body.receiptId !== "string" || !body.receiptId.trim() || body.receiptId.length > 128) throw new TaxServiceError("invalid_receipt", 400, "رسید نامعتبر است.");
    outcome = { state: status, receiptId: body.receiptId };
  } else if (status === "rejected") {
    if (!Array.isArray(body.issues) || body.issues.length === 0 || body.issues.length > 100 || !body.issues.every((issue) => issue && typeof issue.code === "string" && issue.code.length <= 128 && typeof issue.message === "string" && issue.message.length <= 2000 && (issue.field === undefined || (typeof issue.field === "string" && issue.field.length <= 200)))) {
      throw new TaxServiceError("invalid_issues", 400, "خطاهای استعلام نامعتبر است.");
    }
    outcome = { state: "rejected", issues: body.issues.map((issue): ProviderIssue => ({ code: issue.code, message: issue.message, ...(issue.field ? { field: issue.field } : {}) })) };
  } else throw new TaxServiceError("invalid_status", 400, "وضعیت نامعتبر است.");
  return { eventId: body.eventId, uid: body.uid, provider: body.provider as Callback["provider"], outcome };
}

/** Tenant from the URL selects a scoped key; ONLY its signature authorizes a mutation. No RLS bypass. */
export async function applyTaxCallback(businessId: string, raw: string, headers: Headers, now = new Date()): Promise<{ duplicate: boolean; ignored?: boolean }> {
  if (!UUID.test(businessId) || Buffer.byteLength(raw) > MAX_BODY) throw new TaxServiceError("invalid_callback", 400, "پیام نامعتبر است.");
  return withTenantTransaction(businessId, async () => {
    await query("SELECT id FROM businesses WHERE id = $1 FOR KEY SHARE", [businessId]);
    const profile = await query<{ credentials_ciphertext: string | null }>(`SELECT credentials_ciphertext FROM tax_invoice_profiles WHERE business_id = $1`, [businessId]);
    const ciphertext = profile.rows[0]?.credentials_ciphertext;
    const credentials = ciphertext ? JSON.parse(decryptSecret(ciphertext, resolveEncryptionKey(process.env))) : null;
    if (!verifyTaxCallbackSignature(businessId, raw, headers.get("x-tax-timestamp"), headers.get("x-tax-signature"), credentials?.webhookSecret, now)) {
      throw new TaxServiceError("invalid_signature", 401, "امضای پیام نامعتبر است.");
    }
    const callback = parseCallback(raw);
    // Serialize the event identity as well as the invoice (including conflicting uid replays).
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tax-callback:${businessId}:${callback.eventId}`]);
    const hash = createHash("sha256").update(raw).digest("hex");
    const seen = await query<{ callback_hash: string }>(`SELECT callback_hash FROM tax_invoice_events WHERE business_id = $1 AND callback_event_id = $2`, [businessId, callback.eventId]);
    if (seen.rows[0]) {
      if (seen.rows[0].callback_hash !== hash) throw new TaxServiceError("callback_conflict", 409, "شناسه پیام قبلاً با محتوای دیگری ثبت شده است.");
      taxLog("callback.duplicate", { businessId, eventId: callback.eventId });
      return { duplicate: true };
    }
    const result = await query<{ id: string; order_id: string; status: TaxStatus; attempts: number; receipt_id: string | null; kind: TaxKind; parent_submission_id: string | null; correlation_id: string }>(
      `SELECT id, order_id, status, attempts, receipt_id, kind, parent_submission_id, correlation_id
       FROM tax_invoice_submissions WHERE business_id = $1 AND uid = $2 AND provider = $3 FOR UPDATE`, [businessId, callback.uid, callback.provider]);
    const record = result.rows[0];
    if (!record) throw new TaxServiceError("not_found", 404, "صورتحساب یافت نشد.");
    const receipt = "receiptId" in callback.outcome ? callback.outcome.receiptId : null;
    if (receipt && record.receipt_id && receipt !== record.receipt_id) throw new TaxServiceError("receipt_conflict", 409, "رسید با صورتحساب سازگار نیست.");
    const active = ["sending", "submitted", "awaiting_inquiry"].includes(record.status);
    let to = record.status;
    if (active) {
      // A callback can beat the submit response. Preserve legal transitions and the worker CAS.
      if (record.status === "sending") {
        await query(`UPDATE tax_invoice_submissions SET status = 'awaiting_inquiry' WHERE id = $1`, [record.id]);
        await query(`INSERT INTO tax_invoice_events (business_id, submission_id, event_type, from_status, to_status, correlation_id)
          VALUES ($1, $2, 'callback_received_in_flight', 'sending', 'awaiting_inquiry', $3)`, [businessId, record.id, record.correlation_id]);
      }
      const decision = decideAfterInquiry(record.status === "sending" ? "awaiting_inquiry" : record.status, callback.outcome, record.attempts, now);
      to = decision.to;
      await query(`UPDATE tax_invoice_submissions SET status = $2, receipt_id = COALESCE(receipt_id, $3),
        inquiry_result = $4::jsonb, last_inquired_at = $5, next_attempt_at = $6, leased_until = NULL, claim_token = NULL,
        submitted_at = CASE WHEN $3::text IS NOT NULL THEN COALESCE(submitted_at, $5) ELSE submitted_at END,
        provider_errors = $7::jsonb, last_error_code = $8, last_error_message = $9,
        accepted_at = CASE WHEN $2 = 'accepted' THEN COALESCE(accepted_at, $5) ELSE accepted_at END, updated_at = $5
        WHERE id = $1`, [record.id, to, decision.receiptId, JSON.stringify({ state: callback.outcome.state, at: now.toISOString(), via: "callback" }), now, decision.nextAttemptAt, JSON.stringify(decision.providerErrors), decision.errorCode, decision.errorMessage]);
      if (to === "accepted" && record.kind === "cancellation" && record.parent_submission_id) {
        const parent = await query(`UPDATE tax_invoice_submissions SET status = 'cancelled', updated_at = $2 WHERE id = $1 AND status = 'accepted' RETURNING id`, [record.parent_submission_id, now]);
        if (parent.rowCount) await query(`INSERT INTO tax_invoice_events (business_id, submission_id, event_type, from_status, to_status, correlation_id, detail)
          VALUES ($1, $2, 'cancelled', 'accepted', 'cancelled', $3, $4::jsonb)`, [businessId, record.parent_submission_id, record.correlation_id, JSON.stringify({ byCancellation: record.id })]);
      }
    }
    if (!active && callback.outcome.state === "accepted") {
      // Preserve contradictory signed evidence without rewriting terminal history.
      // A separate hold is evidence, not an assertion that this status is accepted.
      if (!["accepted", "cancelled"].includes(record.status)) {
        await query("SELECT id FROM orders WHERE id = $1 FOR NO KEY UPDATE", [record.order_id]);
        await query(`UPDATE tax_invoice_submissions SET retention_hold_at = COALESCE(retention_hold_at, $2) WHERE id = $1`, [record.id, now]);
      }
    }
    await query(`INSERT INTO tax_invoice_events (business_id, submission_id, event_type, from_status, to_status, correlation_id, detail, callback_event_id, callback_hash)
      VALUES ($1, $2, 'provider_callback', $3, $4, $5, $6::jsonb, $7, $8)`, [businessId, record.id, record.status === "sending" && active ? "awaiting_inquiry" : record.status, to, record.correlation_id, JSON.stringify({ provider: callback.provider, state: callback.outcome.state, outcome: callback.outcome, ignored: !active, anomaly: !active && callback.outcome.state !== record.status }), callback.eventId, hash]);
    taxLog("callback.recorded", { businessId, submissionId: record.id, correlationId: record.correlation_id, eventId: callback.eventId, from: record.status, to, ignored: !active });
    return { duplicate: false, ignored: !active };
  });
}
