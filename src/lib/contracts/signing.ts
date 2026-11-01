/**
 * Issue #908 (phase C) — the e-signing envelope: invitations, OTP, signatures,
 * evidence and the public signer's session.
 *
 * ## The shape
 *
 * A contract has at most ONE live envelope (`sent` / `partially_signed`), and an
 * envelope points at ONE frozen `contract_document_versions` row. That
 * version — not the draft — is what every signer is shown, and its SHA-256 is
 * stored again on each signature. So "what did this person actually sign" is a
 * row, not a reconstruction.
 *
 * ## Who may do what
 *
 * Two authorities exist and they never mix:
 *
 *  - **Inside the tenant**, every function takes the `WorkspaceOwner` the route
 *    built from the session. Authorisation is `workspace.contracts_manage` plus
 *    `edit` on the contract as a workspace subject — resolved by the route
 *    before calling in here, exactly like `workspace.ts`.
 *  - **On the public signing page**, the ONLY authority is the token. It is
 *    never combined with a business id, contract id or signer id from the
 *    request: the token resolves to one invitation, and that invitation names
 *    its own signer, envelope and business. The lookup therefore runs with the
 *    documented platform bypass (`withoutTenantScope("contract-signing-token")`)
 *    and everything after it re-enters the resolved tenant with `withTenant`.
 *    A caller with a valid token for one signing session can never reach another
 *    tenant's rows, because it never supplies an id at all.
 *
 * ## What is never stored
 *
 * The invitation token (HMAC only), the OTP (the existing `mfa_challenges`
 * hashing, five-minute TTL, five attempts), and any log line containing either.
 * Signing evidence records facts — who, when, which version hash, which
 * placement, a truncated IP — and never a credential.
 */
import { query, withTenant, withoutTenantScope } from "../db";
import { isMobilePhone, phoneE164 } from "../phone";
import {
  issueOtpChallenge,
  normalizeOtpCode,
  redeemOtpChallenge,
  type OtpPurpose,
} from "../otp-challenge";
import { getSmsProvider } from "../sms-config";
import { formatJalali } from "../jalali";
import { recordActivity, WorkspaceError, type WorkspaceContract, type WorkspaceOwner } from "../workspace";
import { CONTRACT_LIMITS, normalizeContractContent, signatureSlots, type ContractDocumentContent } from "./blocks";
import { contractContentHash, hashInvitationToken, looksLikeInvitationToken, newInvitationToken } from "./crypto";
import { SIGNING_EVENT_LABELS } from "./labels";
import type {
  ContractEnvelope,
  ContractEnvelopeStatus,
  ContractSigner,
  ContractSignerStatus,
  ContractSigningEvent,
  ContractSigningMode,
  ContractSigningOverview,
  MessageDelivery,
  SendEnvelopeResult,
  SigningSessionFailure,
  SigningSessionView,
  SubmitSignatureResult,
} from "./view";
import { ensureContractDocument, freezeContractDocument, getFrozenVersion } from "./service";

/** The OTP purpose and realm a contract signature uses. */
export const CONTRACT_SIGNING_OTP_PURPOSE: OtpPurpose = "contract_signing";
export const CONTRACT_SIGNER_REALM = "contract_signer";

/** How long an invitation link stays usable, in days, when nothing else is said. */
export const DEFAULT_INVITATION_DAYS = 14;
export const MAX_INVITATION_DAYS = 60;

export { ENVELOPE_STATUSES, SIGNER_STATUSES, SIGNING_MODES } from "./view";

export {
  ENVELOPE_STATUS_LABELS,
  SIGNER_STATUS_LABELS,
  SIGNING_EVENT_LABELS,
} from "./labels";

/* ===========================================================================
 * Pure helpers
 * ======================================================================== */

/** «۰۹۱۲•••۴۵۶۷» — enough to recognise a number, not enough to reuse one. */
export function maskPhone(value: string): string {
  const digits = (value.startsWith("+98") ? `0${value.slice(3)}` : value).replace(/\D/g, "");
  if (digits.length < 7) return "•••";
  return `${digits.slice(0, 4)}•••${digits.slice(-4)}`;
}

/**
 * A truncated client IP for the evidence trail: full addresses are personal
 * data that a contract does not need, and a /24 (or /64 for IPv6) is enough to
 * corroborate a dispute.
 */
export function truncateIp(value: string | null | undefined): string {
  const raw = (value ?? "").split(",")[0].trim();
  if (!raw) return "";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return raw.split(".").slice(0, 3).join(".") + ".0";
  if (raw.includes(":")) return raw.split(":").slice(0, 4).join(":") + "::";
  return "";
}

/** Whether this signer may sign RIGHT NOW under the envelope's ordering. */
export function signerMayAct(
  envelope: { signing_mode: ContractSigningMode; status: ContractEnvelopeStatus },
  signers: { id: string; sign_order: number; status: ContractSignerStatus; required: boolean }[],
  signer: { id: string; sign_order: number; status: ContractSignerStatus },
): { ok: boolean; reason?: "not_live" | "already_signed" | "declined" | "turn_pending" } {
  if (envelope.status !== "sent" && envelope.status !== "partially_signed") {
    return { ok: false, reason: "not_live" };
  }
  if (signer.status === "signed") return { ok: false, reason: "already_signed" };
  if (signer.status === "declined") return { ok: false, reason: "declined" };
  if (envelope.signing_mode === "parallel") return { ok: true };
  const blocking = signers.some(
    (other) =>
      other.id !== signer.id &&
      other.required &&
      other.sign_order < signer.sign_order &&
      other.status !== "signed",
  );
  return blocking ? { ok: false, reason: "turn_pending" } : { ok: true };
}

/** How many of the required signers have signed. */
export function signingProgress(
  signers: { status: ContractSignerStatus; required: boolean }[],
): { required: number; signed: number; complete: boolean } {
  const required = signers.filter((signer) => signer.required);
  const signed = required.filter((signer) => signer.status === "signed").length;
  return { required: required.length, signed, complete: required.length > 0 && signed === required.length };
}

/* ===========================================================================
 * Rows
 * ======================================================================== */

export type {
  ContractEnvelope,
  ContractSigner,
  ContractSigningEvent,
  ContractSigningOverview,
  MessageDelivery,
  SendEnvelopeResult,
  SigningReceipt,
  SigningSessionFailure,
  SigningSessionView,
  SubmitSignatureResult,
} from "./view";

function toSigner(row: Record<string, unknown>): ContractSigner {
  const phone = String(row.phone_e164 ?? "");
  return {
    id: String(row.id),
    fullName: String(row.full_name ?? ""),
    roleLabel: String(row.role_label ?? ""),
    maskedPhone: maskPhone(phone),
    phoneE164: phone,
    signOrder: Number(row.sign_order ?? 1),
    required: row.required !== false,
    slotId: String(row.slot_id ?? ""),
    status: row.status as ContractSignerStatus,
    deadline: row.deadline ? String(row.deadline).slice(0, 10) : null,
    invitedAt: row.invited_at ? String(row.invited_at) : null,
    openedAt: row.opened_at ? String(row.opened_at) : null,
    acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null,
    signedAt: row.signed_at ? String(row.signed_at) : null,
    declinedAt: row.declined_at ? String(row.declined_at) : null,
    declineReason: String(row.decline_reason ?? ""),
    partyId: (row.party_id as string | null) ?? null,
  };
}

function toEnvelope(row: Record<string, unknown> | undefined): ContractEnvelope | null {
  if (!row) return null;
  return {
    id: String(row.id),
    contractId: String(row.contract_id),
    documentVersionId: String(row.document_version_id),
    documentVersion: row.document_version === undefined || row.document_version === null
      ? null
      : Number(row.document_version),
    status: row.status as ContractEnvelopeStatus,
    signingMode: row.signing_mode as ContractSigningMode,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    sentAt: row.sent_at ? String(row.sent_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
    cancelReason: String(row.cancel_reason ?? ""),
    createdAt: String(row.created_at),
  };
}

async function latestEnvelope(businessId: string, contractId: string): Promise<ContractEnvelope | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT e.*, v.version AS document_version
       FROM contract_signing_envelopes e
       JOIN contract_document_versions v ON v.id = e.document_version_id
      WHERE e.contract_id = $1 AND e.business_id = $2
      ORDER BY e.created_at DESC
      LIMIT 1`,
    [contractId, businessId],
  );
  return toEnvelope(rows[0]);
}

async function signersOf(envelopeId: string): Promise<ContractSigner[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM contract_signers WHERE envelope_id = $1 ORDER BY sign_order, created_at`,
    [envelopeId],
  );
  return rows.map(toSigner);
}

async function eventsOf(envelopeId: string): Promise<ContractSigningEvent[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT e.id, e.kind, e.detail, e.created_at, e.signer_id, s.full_name
       FROM contract_signing_events e
       LEFT JOIN contract_signers s ON s.id = e.signer_id
      WHERE e.envelope_id = $1
      ORDER BY e.id DESC
      LIMIT 100`,
    [envelopeId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind),
    label: SIGNING_EVENT_LABELS[String(row.kind)] ?? String(row.kind),
    signerId: (row.signer_id as string | null) ?? null,
    signerName: (row.full_name as string | null) ?? null,
    detail: (row.detail as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
  }));
}

/** What the request itself contributes to the trail: no credentials, just facts. */
export interface ClientFacts {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Appends one evidence row.
 *
 * `detail` is deliberately narrow: counts, hashes, statuses and delivery
 * outcomes. Nothing secret is ever passed in, and the table has no UPDATE or
 * DELETE policy, so the trail cannot be rewritten through the app role.
 */
async function appendEvent(
  businessId: string,
  envelopeId: string,
  kind: string,
  detail: Record<string, unknown> = {},
  signerId: string | null = null,
): Promise<void> {
  await query(
    `INSERT INTO contract_signing_events (business_id, envelope_id, signer_id, kind, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [businessId, envelopeId, signerId, kind, JSON.stringify(detail)],
  );
}

/* ===========================================================================
 * Sender side
 * ======================================================================== */

export async function getSigningOverview(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
): Promise<ContractSigningOverview> {
  const envelope = await latestEnvelope(owner.businessId, contract.id);
  if (!envelope) {
    return {
      envelope: null,
      signers: [],
      events: [],
      progress: { required: 0, signed: 0, complete: false },
      draftAheadOfFrozen: false,
      latestFrozenVersion: null,
      capabilities: { canSend: false, canCancel: false, canResend: false },
    };
  }
  const [signers, events] = await Promise.all([signersOf(envelope.id), eventsOf(envelope.id)]);
  const progress = signingProgress(signers);
  const { rows: versionRows } = await query<{ version: number }>(
    `SELECT max(version) AS version FROM contract_document_versions
      WHERE contract_id = $1 AND business_id = $2`,
    [contract.id, owner.businessId],
  );
  const latestFrozen = versionRows[0]?.version === null || versionRows[0]?.version === undefined
    ? null
    : Number(versionRows[0].version);
  const live = envelope.status === "sent" || envelope.status === "partially_signed";
  return {
    envelope,
    signers,
    events,
    progress,
    draftAheadOfFrozen: latestFrozen !== null && envelope.documentVersion !== null
      && latestFrozen > envelope.documentVersion,
    latestFrozenVersion: latestFrozen,
    capabilities: {
      canSend: envelope.status === "draft",
      canCancel: live || envelope.status === "draft",
      canResend: live,
    },
  };
}

export interface SignerDraftInput {
  id?: string;
  fullName?: unknown;
  phone?: unknown;
  roleLabel?: unknown;
  slotId?: unknown;
  order?: unknown;
  required?: unknown;
  deadline?: unknown;
  partyId?: unknown;
}

export interface NormalizedSignerDraft {
  fullName: string;
  phoneE164: string;
  roleLabel: string;
  slotId: string;
  signOrder: number;
  required: boolean;
  deadline: string | null;
  partyId: string | null;
}

/**
 * The placements available in the contract's CURRENT document.
 *
 * Derived on the server from the stored block tree rather than accepted from
 * the client: a caller could otherwise name a `slot_id` that does not exist in
 * the document, and "where does this signature go" would be a claim instead of
 * a fact.
 */
async function documentSlots(owner: WorkspaceOwner, contract: WorkspaceContract) {
  const document = await ensureContractDocument(owner, contract);
  return signatureSlots(document.content);
}

/**
 * Validate and normalise the sender's signer list against the document.
 *
 * Refusals are specific codes (not one generic 400) because the Persian message
 * differs: a duplicate number, an unassigned placement and a non-mobile number
 * are three different corrections.
 */
async function normalizeSigners(
  owner: WorkspaceOwner,
  input: unknown,
  slots: { slotId: string }[],
): Promise<NormalizedSignerDraft[]> {
  const list = Array.isArray(input) ? input : [];
  if (list.length === 0) throw new WorkspaceError("signers_required");
  if (list.length > CONTRACT_LIMITS.signersMax) throw new WorkspaceError("too_many_signers");
  const slotIds = new Set(slots.map((slot) => slot.slotId));
  const seenPhones = new Set<string>();
  const seenSlots = new Set<string>();
  const out: NormalizedSignerDraft[] = [];
  for (const [index, raw] of list.entries()) {
    const item = (raw ?? {}) as SignerDraftInput;
    const fullName = String(item.fullName ?? "").trim().slice(0, 120);
    if (!fullName) throw new WorkspaceError("signer_name_required");
    const phone = String(item.phone ?? "").trim();
    const e164 = phoneE164(phone);
    if (!e164 || !isMobilePhone(phone)) throw new WorkspaceError("signer_phone_invalid");
    if (seenPhones.has(e164)) throw new WorkspaceError("signer_phone_duplicate");
    seenPhones.add(e164);
    const slotId = String(item.slotId ?? "").trim();
    if (!slotIds.has(slotId)) throw new WorkspaceError("signer_slot_invalid");
    if (seenSlots.has(slotId)) throw new WorkspaceError("signer_slot_duplicate");
    seenSlots.add(slotId);
    const order = Number(item.order);
    const deadline = item.deadline ? String(item.deadline).slice(0, 10) : null;
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new WorkspaceError("invalid_date");
    const partyId = item.partyId ? String(item.partyId) : null;
    if (partyId) {
      const { rowCount } = await query(`SELECT 1 FROM parties WHERE id = $1 AND business_id = $2`, [
        partyId,
        owner.businessId,
      ]);
      if (!rowCount) throw new WorkspaceError("party_not_found");
    }
    out.push({
      fullName,
      phoneE164: e164,
      roleLabel: String(item.roleLabel ?? "").trim().slice(0, 80),
      slotId,
      signOrder: Number.isSafeInteger(order) && order >= 1 ? order : index + 1,
      required: item.required !== false,
      deadline,
      partyId,
    });
  }
  return out;
}

function normalizedMode(value: unknown): ContractSigningMode {
  return value === "sequential" ? "sequential" : "parallel";
}

function invitationExpiry(days: unknown): Date {
  const parsed = Number(days);
  const bounded = Number.isFinite(parsed)
    ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_INVITATION_DAYS)
    : DEFAULT_INVITATION_DAYS;
  return new Date(Date.now() + bounded * 24 * 60 * 60 * 1000);
}

/**
 * Save the signer list on a DRAFT envelope.
 *
 * Editing signers is only possible while nothing has been sent: once an
 * envelope is live, changing who signs would either invalidate signatures
 * already collected or invite somebody to a document they were not named in.
 * The correction path is «لغو و ارسال دوباره», which is explicit.
 */
export async function saveSigningDraft(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  input: { signingMode?: unknown; signers?: unknown; expiresInDays?: unknown },
): Promise<ContractSigningOverview> {
  const envelope = await latestEnvelope(owner.businessId, contract.id);
  if (envelope && envelope.status !== "draft") throw new WorkspaceError("signing_envelope_not_draft");
  const slots = await documentSlots(owner, contract);
  if (slots.length === 0) throw new WorkspaceError("signature_slot_missing");
  const signers = await normalizeSigners(owner, input.signers, slots);
  const mode = normalizedMode(input.signingMode);
  const expiresAt = invitationExpiry(input.expiresInDays);

  const envelopeId = await withTenant(owner.businessId, async () => {
    let id = envelope?.id;
    if (!id) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO contract_signing_envelopes
           (business_id, contract_id, document_version_id, status, signing_mode, expires_at, created_by)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6)
         RETURNING id`,
        [owner.businessId, contract.id, await latestVersionId(owner, contract), mode, expiresAt, owner.actorUserId],
      );
      id = rows[0].id;
      await appendEvent(owner.businessId, id, "envelope_created", {});
    } else {
      await query(
        `UPDATE contract_signing_envelopes
            SET signing_mode = $3, expires_at = $4, updated_at = now()
          WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
        [id, owner.businessId, mode, expiresAt],
      );
    }
    await query(`DELETE FROM contract_signers WHERE envelope_id = $1 AND business_id = $2`, [
      id,
      owner.businessId,
    ]);
    for (const signer of signers) {
      await query(
        `INSERT INTO contract_signers
           (business_id, envelope_id, party_id, full_name, role_label, phone_e164,
            sign_order, required, slot_id, deadline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          owner.businessId,
          id,
          signer.partyId,
          signer.fullName,
          signer.roleLabel,
          signer.phoneE164,
          signer.signOrder,
          signer.required,
          signer.slotId,
          signer.deadline,
        ],
      );
    }
    await appendEvent(owner.businessId, id, "signers_saved", { count: signers.length, mode });
    return id;
  });

  await recordActivity(owner, {
    projectId: contract.projectId,
    subjectType: "contract",
    subjectId: contract.id,
    action: "contract_signers_saved",
    summary: contract.title,
  });
  void envelopeId;
  return getSigningOverview(owner, contract);
}

/**
 * The draft envelope needs a version id up front (it is NOT NULL). A draft that
 * has never been frozen points at the newest frozen version when there is one,
 * and otherwise freezes the current draft — a draft envelope is the sender's own
 * workspace, so freezing on save is not a commitment to anybody.
 */
async function latestVersionId(owner: WorkspaceOwner, contract: WorkspaceContract): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM contract_document_versions
      WHERE contract_id = $1 AND business_id = $2
      ORDER BY version DESC LIMIT 1`,
    [contract.id, owner.businessId],
  );
  if (rows[0]) return rows[0].id;
  // A draft envelope still needs a version to point at. Freezing the current
  // draft for that purpose is safe — nothing is sent yet, and the sender's own
  // preview is the only reader — and it keeps `document_version_id` NOT NULL
  // honest instead of inventing a nullable "no version yet" state.
  const frozen = await freezeContractDocument(owner, contract, { allowIssues: true });
  return frozen.id;
}

/* ===========================================================================
 * Invitations and delivery
 * ======================================================================== */


/**
 * The one function that composes the signing link.
 *
 * It returns the URL because the sender is allowed to see it: sending a link
 * over the business's own WhatsApp is a legitimate delivery channel, and the
 * alternative (a sender who cannot see the link when the SMS gateway is down)
 * would be a product that cannot sign anything on a bad day.
 */
export function signingUrl(origin: string, token: string): string {
  const base = (origin || "").replace(/\/+$/, "");
  return `${base}/sign/${token}`;
}

interface IssuedInvitation {
  signerId: string;
  signerName: string;
  token: string;
  expiresAt: Date;
}

async function issueInvitations(
  owner: WorkspaceOwner,
  envelopeId: string,
  signerRows: { id: string; full_name: string }[],
  expiresAt: Date,
): Promise<IssuedInvitation[]> {
  const issued: IssuedInvitation[] = [];
  for (const row of signerRows) {
    // Rotating: any live token for this signer stops working the moment a new
    // one exists, so a forwarded old SMS cannot sign twice.
    await query(
      `UPDATE contract_invitations SET revoked_at = now()
        WHERE signer_id = $1 AND revoked_at IS NULL`,
      [row.id],
    );
    const token = newInvitationToken();
    const tokenHash = await hashInvitationToken(token);
    await query(
      `INSERT INTO contract_invitations
         (business_id, envelope_id, signer_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [owner.businessId, envelopeId, row.id, tokenHash, expiresAt],
    );
    await query(
      `UPDATE contract_signers
          SET status = CASE WHEN status = 'pending' THEN 'invited' ELSE status END,
              invited_at = COALESCE(invited_at, now()), updated_at = now()
        WHERE id = $1`,
      [row.id],
    );
    issued.push({ signerId: row.id, signerName: row.full_name, token, expiresAt });
  }
  return issued;
}

/**
 * Deliver one invitation over the platform's SMS provider.
 *
 * The platform abstraction (`sms-config`) exposes an OTP-template send and, on
 * a deployment with a sender line, plain text. Rather than pretend, a missing
 * sender reports `sms_unavailable` and the sender is offered the link to pass
 * on themselves — the epic's "never a fake confirmation".
 */
async function deliverInvitation(
  message: string,
  phone: string,
): Promise<{ delivered: boolean; reason: MessageDelivery["reason"] }> {
  const provider = await getSmsProvider();
  if (provider.name === "noop") return { delivered: false, reason: "sms_not_configured" };
  if (typeof provider.sendText !== "function") return { delivered: false, reason: "sms_unavailable" };
  try {
    await provider.sendText(phone, message);
    return { delivered: true, reason: null };
  } catch {
    // The provider's own error text is Persian and safe, but it is about the
    // gateway (credit, template, IP). The sender needs to know the link is
    // still valid, not which vendor code came back.
    return { delivered: false, reason: "sms_failed" };
  }
}

function invitationMessage(input: {
  businessName: string;
  contractTitle: string;
  signerName: string;
  url: string;
  expiresAt: Date;
}): string {
  const until = formatJalali(input.expiresAt, { withMonthName: true, timeZone: "Asia/Tehran" });
  return `«${input.businessName}» قرارداد «${input.contractTitle}» را برای امضا فرستاده است. ${input.signerName} عزیز، متن کامل سند را در این نشانی ببینید و امضا کنید: ${input.url} — اعتبار پیوند تا ${until}.`;
}

/* ===========================================================================
 * Send / resend / cancel
 * ======================================================================== */


/**
 * Freeze the current draft and send it.
 *
 * Order matters: the freeze happens FIRST (and refuses while anything is
 * unresolved), so an envelope can never point at a version that does not exist
 * or at one the signers were not shown. SMS delivery happens after the commit
 * and its outcome never rolls the envelope back — an invitation that failed to
 * send is a retryable delivery problem, not a lost signature.
 */
export async function sendEnvelope(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  input: {
    signingMode?: unknown;
    signers?: unknown;
    expiresInDays?: unknown;
    origin: string;
  },
  freeze: () => Promise<{ id: string; version: number; contentHash: string; content: ContractDocumentContent }>,
): Promise<SendEnvelopeResult> {
  const existing = await latestEnvelope(owner.businessId, contract.id);
  if (existing && existing.status !== "draft") throw new WorkspaceError("signing_already_sent");

  const slots = await documentSlots(owner, contract);
  if (slots.length === 0) throw new WorkspaceError("signature_slot_missing");
  const signers = input.signers ? await normalizeSigners(owner, input.signers, slots) : null;
  const mode = normalizedMode(input.signingMode);
  const expiresAt = invitationExpiry(input.expiresInDays);

  const frozen = await freeze();

  const { envelope, firstSigners } = await withTenant(owner.businessId, async () => {
    let envelopeId = existing?.id;
    if (!envelopeId) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO contract_signing_envelopes
           (business_id, contract_id, document_version_id, status, signing_mode, expires_at, created_by)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6) RETURNING id`,
        [owner.businessId, contract.id, frozen.id, mode, expiresAt, owner.actorUserId],
      );
      envelopeId = rows[0].id;
      await appendEvent(owner.businessId, envelopeId, "envelope_created", {});
    }
    await query(
      `UPDATE contract_signing_envelopes
          SET document_version_id = $3, signing_mode = $4, expires_at = $5,
              status = 'sent', sent_at = now(), updated_at = now()
        WHERE id = $1 AND business_id = $2 AND status = 'draft'`,
      [envelopeId, owner.businessId, frozen.id, mode, expiresAt],
    );
    if (signers) {
      await query(`DELETE FROM contract_signers WHERE envelope_id = $1 AND business_id = $2`, [
        envelopeId,
        owner.businessId,
      ]);
      for (const signer of signers) {
        await query(
          `INSERT INTO contract_signers
             (business_id, envelope_id, party_id, full_name, role_label, phone_e164,
              sign_order, required, slot_id, deadline)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            owner.businessId,
            envelopeId,
            signer.partyId,
            signer.fullName,
            signer.roleLabel,
            signer.phoneE164,
            signer.signOrder,
            signer.required,
            signer.slotId,
            signer.deadline,
          ],
        );
      }
    }
    const { rows: signerRows } = await query<{ id: string; full_name: string; sign_order: number }>(
      `SELECT id, full_name, sign_order FROM contract_signers
        WHERE envelope_id = $1 ORDER BY sign_order, created_at`,
      [envelopeId],
    );
    if (signerRows.length === 0) throw new WorkspaceError("signers_required");
    // In sequential mode only the first signer is invited now; each later
    // signer is invited when their turn arrives (`advanceSequential`).
    const firstOrder = Math.min(...signerRows.map((row) => row.sign_order));
    const live = mode === "sequential"
      ? signerRows.filter((row) => row.sign_order === firstOrder)
      : signerRows;
    const issued = await issueInvitations(
      owner,
      envelopeId,
      live.map((row) => ({ id: row.id, full_name: row.full_name })),
      expiresAt,
    );
    await appendEvent(owner.businessId, envelopeId, "envelope_sent", {
      mode,
      signers: signerRows.length,
      invited: live.length,
      version: frozen.version,
      contentHash: frozen.contentHash,
    });
    const reloaded = await latestEnvelope(owner.businessId, contract.id);
    return { envelope: reloaded as ContractEnvelope, firstSigners: issued };
  });

  const deliveries = await deliverIssued(owner, envelope.id, firstSigners, contract, input.origin);
  await recordActivity(owner, {
    projectId: contract.projectId,
    subjectType: "contract",
    subjectId: contract.id,
    action: "contract_sent_for_signing",
    summary: `${contract.title} — v${frozen.version}`,
  });

  return {
    envelope,
    version: { id: frozen.id, version: frozen.version, contentHash: frozen.contentHash },
    deliveries,
  };
}

async function deliverIssued(
  owner: WorkspaceOwner,
  envelopeId: string,
  issued: IssuedInvitation[],
  contract: WorkspaceContract,
  origin: string,
): Promise<MessageDelivery[]> {
  const { rows } = await query<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [
    owner.businessId,
  ]);
  const businessName = rows[0]?.name ?? "";
  const deliveries: MessageDelivery[] = [];
  for (const invitation of issued) {
    const url = signingUrl(origin, invitation.token);
    const { rows: signerRows } = await query<{ phone_e164: string }>(
      `SELECT phone_e164 FROM contract_signers WHERE id = $1`,
      [invitation.signerId],
    );
    const message = invitationMessage({
      businessName,
      contractTitle: contract.title,
      signerName: invitation.signerName,
      url,
      expiresAt: invitation.expiresAt,
    });
    const result = await deliverInvitation(message, signerRows[0]?.phone_e164 ?? "");
    if (result.delivered) {
      await query(
        `UPDATE contract_invitations
            SET send_count = send_count + 1, last_sent_at = now()
          WHERE signer_id = $1 AND revoked_at IS NULL`,
        [invitation.signerId],
      );
      await appendEvent(owner.businessId, envelopeId, "invitation_sent", {}, invitation.signerId);
    } else {
      await appendEvent(
        owner.businessId,
        envelopeId,
        "invitation_failed",
        { reason: result.reason, channel: "sms" },
        invitation.signerId,
      );
    }
    deliveries.push({
      signerId: invitation.signerId,
      delivered: result.delivered,
      reason: result.reason,
      url,
    });
  }
  return deliveries;
}

/**
 * Rotate one signer's link and (optionally) re-send it.
 *
 * Always returns the URL: when `channel` is `"link"` nothing is sent and the
 * sender gets a fresh single-use link to pass on themselves; when it is
 * `"sms"` the same link is texted and the URL is still returned so the sender
 * can see what was sent if delivery failed.
 */
export async function resendInvitation(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  signerId: string,
  input: { channel?: unknown; origin: string },
): Promise<MessageDelivery> {
  const envelope = await latestEnvelope(owner.businessId, contract.id);
  if (!envelope) throw new WorkspaceError("signing_envelope_not_found");
  if (envelope.status !== "sent" && envelope.status !== "partially_signed") {
    throw new WorkspaceError("signing_envelope_not_live");
  }
  const signers = await signersOf(envelope.id);
  const signer = signers.find((candidate) => candidate.id === signerId);
  if (!signer) throw new WorkspaceError("signer_not_found");
  if (signer.status === "signed") throw new WorkspaceError("signer_already_signed");
  if (signer.status === "declined") throw new WorkspaceError("signer_declined");
  const mayAct = signerMayAct(
    { signing_mode: envelope.signingMode, status: envelope.status },
    signers.map((candidate) => ({
      id: candidate.id,
      sign_order: candidate.signOrder,
      status: candidate.status,
      required: candidate.required,
    })),
    { id: signer.id, sign_order: signer.signOrder, status: signer.status },
  );
  if (!mayAct.ok && mayAct.reason === "turn_pending") throw new WorkspaceError("signing_not_your_turn");

  const expiresAt = envelope.expiresAt ? new Date(envelope.expiresAt) : invitationExpiry(undefined);
  const issued = await issueInvitations(owner, envelope.id, [{ id: signer.id, full_name: signer.fullName }], expiresAt);
  await appendEvent(owner.businessId, envelope.id, "invitation_rotated", {
    channel: input.channel === "link" ? "link" : "sms",
  }, signer.id);

  const url = signingUrl(input.origin, issued[0].token);
  if (input.channel === "link") {
    return { signerId: signer.id, delivered: false, reason: null, url };
  }
  const [delivery] = await deliverIssued(owner, envelope.id, issued, contract, input.origin);
  return delivery ?? { signerId: signer.id, delivered: false, reason: "sms_failed", url };
}

export async function cancelEnvelope(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  input: { reason?: unknown },
): Promise<ContractSigningOverview> {
  const envelope = await latestEnvelope(owner.businessId, contract.id);
  if (!envelope) throw new WorkspaceError("signing_envelope_not_found");
  if (envelope.status !== "draft" && envelope.status !== "sent" && envelope.status !== "partially_signed") {
    throw new WorkspaceError("signing_envelope_not_live");
  }
  const reason = String(input.reason ?? "").trim().slice(0, 500);
  await withTenant(owner.businessId, async () => {
    await query(
      `UPDATE contract_signing_envelopes
          SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = now()
        WHERE id = $1 AND business_id = $2 AND status IN ('draft', 'sent', 'partially_signed')`,
      [envelope.id, owner.businessId, reason],
    );
    await query(
      `UPDATE contract_invitations SET revoked_at = now()
        WHERE envelope_id = $1 AND revoked_at IS NULL`,
      [envelope.id],
    );
    await query(
      `UPDATE contract_signers SET status = 'expired', updated_at = now()
        WHERE envelope_id = $1 AND status NOT IN ('signed', 'declined')`,
      [envelope.id],
    );
    await appendEvent(owner.businessId, envelope.id, "envelope_cancelled", {});
  });
  await recordActivity(owner, {
    projectId: contract.projectId,
    subjectType: "contract",
    subjectId: contract.id,
    action: "contract_signing_cancelled",
    summary: contract.title,
  });
  return getSigningOverview(owner, contract);
}

/* ===========================================================================
 * The public signing session
 * ======================================================================== */

interface TokenRow {
  invitation_id: string;
  invitation_expires_at: Date;
  invitation_revoked_at: Date | null;
  business_id: string;
  business_name: string;
  contract_id: string;
  contract_title: string;
  envelope_id: string;
  envelope_status: ContractEnvelopeStatus;
  signing_mode: ContractSigningMode;
  version_id: string;
  version_number: number;
  version_title: string;
  version_content: unknown;
  version_hash: string;
  version_frozen_at: Date;
  signer_id: string;
  signer_name: string;
  signer_role: string;
  signer_status: ContractSignerStatus;
  signer_order: number;
  signer_required: boolean;
  signer_slot: string;
  signer_phone: string;
  signer_acknowledged_at: Date | null;
  signer_signed_at: Date | null;
}

/**
 * Resolve a token to exactly one signing session.
 *
 * Runs with the documented platform bypass because the business is not known
 * until the token names it — the same shape as `api-key-auth` and
 * `server-sync-auth` in `db.ts`. Nothing else is reachable from here: the query
 * takes a hash and returns one invitation's own signer/envelope/contract.
 */
async function resolveToken(token: string): Promise<TokenRow | null> {
  if (!looksLikeInvitationToken(token)) return null;
  const hash = await hashInvitationToken(token);
  return withoutTenantScope("contract-signing-token", async () => {
    const { rows } = await query<TokenRow & Record<string, unknown>>(
      `SELECT i.id AS invitation_id,
              i.expires_at AS invitation_expires_at,
              i.revoked_at AS invitation_revoked_at,
              c.business_id,
              b.name AS business_name,
              c.id AS contract_id,
              c.title AS contract_title,
              e.id AS envelope_id,
              e.status AS envelope_status,
              e.signing_mode,
              v.id AS version_id,
              v.version AS version_number,
              v.title AS version_title,
              v.content AS version_content,
              v.content_hash AS version_hash,
              v.frozen_at AS version_frozen_at,
              s.id AS signer_id,
              s.full_name AS signer_name,
              s.role_label AS signer_role,
              s.status AS signer_status,
              s.sign_order AS signer_order,
              s.required AS signer_required,
              s.slot_id AS signer_slot,
              s.phone_e164 AS signer_phone,
              s.acknowledged_at AS signer_acknowledged_at,
              s.signed_at AS signer_signed_at
         FROM contract_invitations i
         JOIN contract_signers s ON s.id = i.signer_id
         JOIN contract_signing_envelopes e ON e.id = i.envelope_id
         JOIN workspace_contracts c ON c.id = e.contract_id
         JOIN businesses b ON b.id = c.business_id
         JOIN contract_document_versions v ON v.id = e.document_version_id
        WHERE i.token_hash = $1`,
      [hash],
    );
    return rows[0] ?? null;
  });
}

/**
 * Whether an envelope's invitation window has closed.
 *
 * `expires_at` is checked at read time rather than by a scheduled job: there is
 * nothing to deliver on expiry (the links are the only artifact), so a lazy
 * check is both simpler and impossible to leave un-run.
 */
export function envelopeExpired(envelope: { expiresAt: string | null }, now: Date = new Date()): boolean {
  if (!envelope.expiresAt) return false;
  const at = new Date(envelope.expiresAt).getTime();
  return Number.isFinite(at) && at <= now.getTime();
}

/**
 * Open a signing session, recording the first open.
 *
 * Reading is where `opened` is stamped: the epic's timeline distinguishes
 * "invited" from "opened", and the only honest place to learn that somebody
 * looked is the request that served them the document.
 */
export async function openSigningSession(
  token: string,
  facts: ClientFacts = {},
): Promise<SigningSessionView> {
  const row = await resolveToken(token);
  if (!row) throw new WorkspaceError("invalid_link");
  return withTenant(row.business_id, async () => {
    if (row.invitation_revoked_at) throw new WorkspaceError("link_revoked");
    const expired = new Date(row.invitation_expires_at).getTime() <= Date.now();
    if (expired) throw new WorkspaceError("link_expired");

    const document: ContractDocumentContent = normalizeContractContent(row.version_content);
    const signers = await signersOf(row.envelope_id);
    const progress = signingProgress(signers);
    const envelope = await latestEnvelope(row.business_id, row.contract_id);

    const isSigned = row.signer_status === "signed" || row.signer_signed_at !== null;
    if (row.envelope_status === "completed" || isSigned) {
      return {
        state: "receipt",
        failure: null,
        business: { name: row.business_name },
        contract: { title: row.contract_title, signedVersion: row.version_number },
        document: {
          title: row.version_title,
          content: document,
          contentHash: row.version_hash,
          version: row.version_number,
          frozenAt: row.version_frozen_at.toISOString(),
        },
        signer: {
          fullName: row.signer_name,
          roleLabel: row.signer_role,
          maskedPhone: maskPhone(row.signer_phone),
          status: row.signer_status,
          acknowledged: true,
          signedAt: row.signer_signed_at ? row.signer_signed_at.toISOString() : null,
        },
        envelope: {
          status: row.envelope_status,
          signingMode: row.signing_mode,
          expiresAt: envelope?.expiresAt ?? null,
        },
        progress,
        step: "receipt",
        signedAt: row.signer_signed_at ? row.signer_signed_at.toISOString() : null,
        signatureHash: row.version_hash,
      } satisfies SigningSessionView;
    }

    if (
      row.envelope_status === "cancelled" ||
      row.envelope_status === "declined" ||
      row.envelope_status === "expired" ||
      (envelope && envelopeExpired(envelope))
    ) {
      return closedSession(row, document, progress, envelopeExpired(envelope ?? { expiresAt: null }) ? "expired" : row.envelope_status);
    }

    // First open: stamp it (and only once).
    if (row.signer_status === "pending" || row.signer_status === "invited") {
      await query(
        `UPDATE contract_signers
            SET status = 'opened', opened_at = COALESCE(opened_at, now()), updated_at = now()
          WHERE id = $1 AND status IN ('pending', 'invited')`,
        [row.signer_id],
      );
      await appendEvent(
        row.business_id,
        row.envelope_id,
        "opened",
        { ip: truncateIp(facts.ip), userAgent: (facts.userAgent ?? "").slice(0, 200) },
        row.signer_id,
      );
    }

    const mayAct = signerMayAct(
      { signing_mode: row.signing_mode, status: row.envelope_status },
      signers.map((signer) => ({
        id: signer.id,
        sign_order: signer.signOrder,
        status: signer.status,
        required: signer.required,
      })),
      { id: row.signer_id, sign_order: row.signer_order, status: row.signer_status },
    );

    const acknowledged = row.signer_acknowledged_at !== null;
    const step: SigningSessionView["step"] = !mayAct.ok
      ? "turn_pending"
      : acknowledged
        ? "verify"
        : "review";

    return {
      state: "active",
      failure: mayAct.ok ? null : (mayAct.reason as SigningSessionFailure | undefined) ?? null,
      business: { name: row.business_name },
      contract: { title: row.contract_title, signedVersion: row.version_number },
      document: {
        title: row.version_title,
        content: document,
        contentHash: row.version_hash,
        version: row.version_number,
        frozenAt: row.version_frozen_at.toISOString(),
      },
      signer: {
        fullName: row.signer_name,
        roleLabel: row.signer_role,
        maskedPhone: maskPhone(row.signer_phone),
        status: row.signer_status,
        acknowledged,
        signedAt: null,
      },
      envelope: {
        status: row.envelope_status,
        signingMode: row.signing_mode,
        expiresAt: envelope?.expiresAt ?? null,
      },
      progress,
      step,
      signedAt: null,
      signatureHash: null,
    } satisfies SigningSessionView;
  });
}

function closedSession(
  row: TokenRow,
  document: ContractDocumentContent,
  progress: { required: number; signed: number; complete: boolean },
  closedAs: ContractEnvelopeStatus | "expired" = row.envelope_status,
): SigningSessionView {
  const failure: SigningSessionFailure =
    closedAs === "cancelled"
      ? "envelope_cancelled"
      : closedAs === "declined"
        ? "envelope_declined"
        : "envelope_expired";
  return {
    state: "closed",
    failure,
    business: { name: row.business_name },
    contract: { title: row.contract_title, signedVersion: row.version_number },
    document: {
      title: row.version_title,
      content: document,
      contentHash: row.version_hash,
      version: row.version_number,
      frozenAt: row.version_frozen_at.toISOString(),
    },
    signer: {
      fullName: row.signer_name,
      roleLabel: row.signer_role,
      maskedPhone: maskPhone(row.signer_phone),
      status: row.signer_status,
      acknowledged: row.signer_acknowledged_at !== null,
      signedAt: row.signer_signed_at ? row.signer_signed_at.toISOString() : null,
    },
    envelope: { status: row.envelope_status, signingMode: row.signing_mode, expiresAt: null },
    progress,
    step: "closed",
    signedAt: null,
    signatureHash: null,
  };
}

/**
 * Explicit consent, recorded before any code is sent.
 *
 * The epic requires the signer to inspect the frozen document and explicitly
 * acknowledge it; that acknowledgement is a row, not a client-side flag, so a
 * signature can never exist without one.
 */
export async function acknowledgeSigningSession(
  token: string,
  input: { consent?: unknown } & ClientFacts,
): Promise<void> {
  const row = await resolveToken(token);
  if (!row) throw new WorkspaceError("invalid_link");
  return withTenant(row.business_id, async () => {
    if (row.invitation_revoked_at) throw new WorkspaceError("link_revoked");
    if (new Date(row.invitation_expires_at).getTime() <= Date.now()) throw new WorkspaceError("link_expired");
    if (input.consent !== true) throw new WorkspaceError("consent_required");
    if (row.envelope_status !== "sent" && row.envelope_status !== "partially_signed") {
      throw new WorkspaceError("signing_envelope_not_live");
    }
    if (row.signer_status === "signed") throw new WorkspaceError("signer_already_signed");
    const { rowCount } = await query(
      `UPDATE contract_signers
          SET status = CASE WHEN status IN ('pending','invited','opened') THEN 'acknowledged' ELSE status END,
              acknowledged_at = COALESCE(acknowledged_at, now()), updated_at = now()
        WHERE id = $1 AND acknowledged_at IS NULL`,
      [row.signer_id],
    );
    if (rowCount) {
      await appendEvent(row.business_id, row.envelope_id, "acknowledged", {
        version: row.version_number,
        contentHash: row.version_hash,
        userAgent: (input.userAgent ?? "").slice(0, 200),
      }, row.signer_id);
    }
  });
}

/** Per-token OTP rate limit: five codes in ten minutes, then a pause. */
async function otpRequestsInWindow(businessId: string, signerId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM contract_signing_events
      WHERE business_id = $1 AND signer_id = $2 AND kind = 'otp_sent'
        AND created_at > now() - interval '10 minutes'`,
    [businessId, signerId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function requestSignerOtp(
  token: string,
  facts: ClientFacts = {},
): Promise<{ delivered: boolean; reason: "sms_not_configured" | "sms_failed" | null; expiresAt: string }> {
  const row = await resolveToken(token);
  if (!row) throw new WorkspaceError("invalid_link");
  return withTenant(row.business_id, async () => {
    if (row.invitation_revoked_at) throw new WorkspaceError("link_revoked");
    if (new Date(row.invitation_expires_at).getTime() <= Date.now()) throw new WorkspaceError("link_expired");
    if (row.envelope_status !== "sent" && row.envelope_status !== "partially_signed") {
      throw new WorkspaceError("signing_envelope_not_live");
    }
    if (row.signer_signed_at) throw new WorkspaceError("signer_already_signed");
    if (row.signer_acknowledged_at === null) throw new WorkspaceError("consent_required");
    if ((await otpRequestsInWindow(row.business_id, row.signer_id)) >= 5) {
      throw new WorkspaceError("otp_rate_limited");
    }

    const issued = await issueOtpChallenge({
      subjectRealm: CONTRACT_SIGNER_REALM,
      subjectId: row.signer_id,
      purpose: CONTRACT_SIGNING_OTP_PURPOSE,
      candidatePhoneE164: row.signer_phone,
    });
    await appendEvent(
      row.business_id,
      row.envelope_id,
      "otp_sent",
      { userAgent: (facts.userAgent ?? "").slice(0, 200) },
      row.signer_id,
    );

    const provider = await getSmsProvider();
    if (provider.name === "noop") {
      return { delivered: false as const, reason: "sms_not_configured" as const, expiresAt: issued.expiresAt.toISOString() };
    }
    try {
      await provider.sendOtp(row.signer_phone, issued.code);
      return { delivered: true as const, reason: null, expiresAt: issued.expiresAt.toISOString() };
    } catch {
      await appendEvent(row.business_id, row.envelope_id, "invitation_failed", { reason: "otp_sms_failed" }, row.signer_id);
      return { delivered: false as const, reason: "sms_failed" as const, expiresAt: issued.expiresAt.toISOString() };
    }
  });
}

export interface SubmitSignatureInput extends ClientFacts {
  code?: unknown;
  fullName?: unknown;
  /** PNG data URL from the signer's canvas. */
  drawnImage?: unknown;
}


/**
 * Commit one signature.
 *
 * Everything that must be true is checked inside ONE tenant transaction that
 * locks the signer row: the code is redeemed (single-use, attempt-limited), the
 * signer is `acknowledged`, the envelope is live, the version hash still matches
 * the envelope, and the placement is the one assigned to this signer. Two
 * concurrent submissions therefore produce exactly one signature — the second
 * blocks, then sees `signed` and is refused.
 */
export async function submitSignature(
  token: string,
  input: SubmitSignatureInput,
): Promise<SubmitSignatureResult> {
  const row = await resolveToken(token);
  if (!row) throw new WorkspaceError("invalid_link");
  return withTenant(row.business_id, async () => {
    if (row.invitation_revoked_at) throw new WorkspaceError("link_revoked");
    if (new Date(row.invitation_expires_at).getTime() <= Date.now()) throw new WorkspaceError("link_expired");
    if (row.envelope_status !== "sent" && row.envelope_status !== "partially_signed") {
      throw new WorkspaceError("signing_envelope_not_live");
    }
    const code = normalizeOtpCode(input.code);
    if (!code) throw new WorkspaceError("otp_invalid");
    const fullName = String(input.fullName ?? "").trim().slice(0, 120);
    if (!fullName) throw new WorkspaceError("signer_name_required");
    const drawn = typeof input.drawnImage === "string" ? input.drawnImage : "";
    if (drawn) {
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(drawn) || drawn.length > 200_000) {
        throw new WorkspaceError("signature_invalid");
      }
    }

    const signers = await signersOf(row.envelope_id);
    const mayAct = signerMayAct(
      { signing_mode: row.signing_mode, status: row.envelope_status },
      signers.map((signer) => ({
        id: signer.id,
        sign_order: signer.signOrder,
        status: signer.status,
        required: signer.required,
      })),
      { id: row.signer_id, sign_order: row.signer_order, status: row.signer_status },
    );
    if (!mayAct.ok) {
      if (mayAct.reason === "already_signed") throw new WorkspaceError("signer_already_signed");
      if (mayAct.reason === "turn_pending") throw new WorkspaceError("signing_not_your_turn");
      throw new WorkspaceError("signing_envelope_not_live");
    }

    const redeemed = await redeemOtpChallenge({
      subjectRealm: CONTRACT_SIGNER_REALM,
      subjectId: row.signer_id,
      purpose: CONTRACT_SIGNING_OTP_PURPOSE,
      code,
      expectedPhoneE164: row.signer_phone,
    });
    if (!redeemed.ok) {
      await appendEvent(row.business_id, row.envelope_id, "otp_failed", { reason: redeemed.reason }, row.signer_id);
      if (redeemed.reason === "expired") throw new WorkspaceError("otp_expired");
      if (redeemed.reason === "attempts_exhausted") throw new WorkspaceError("otp_attempts_exhausted");
      throw new WorkspaceError("otp_invalid");
    }

    const frozen = await getFrozenVersion(row.business_id, row.contract_id, row.version_id);
    if (!frozen) throw new WorkspaceError("contract_document_not_frozen");
    // The version the signer is holding must still be the hash the envelope
    // froze. It cannot drift (versions are immutable), but the check is the
    // one that turns a data-repair mistake into a refusal rather than a
    // signature on the wrong text.
    const recomputed = contractContentHash({
      title: frozen.content.title,
      blocks: frozen.content.blocks,
      values: frozen.content.values ?? {},
      version: frozen.content.version,
    });
    if (recomputed !== row.version_hash) throw new WorkspaceError("contract_version_mismatch");

    const result = await withTenant(row.business_id, async () => {
      const { rows: locked } = await query<{ status: string; acknowledged_at: Date | null; slot_id: string }>(
        `SELECT status, acknowledged_at, slot_id FROM contract_signers WHERE id = $1 FOR UPDATE`,
        [row.signer_id],
      );
      const signer = locked[0];
      if (!signer) throw new WorkspaceError("signer_not_found");
      if (signer.status === "signed") throw new WorkspaceError("signer_already_signed");
      if (!signer.acknowledged_at) throw new WorkspaceError("consent_required");

      await query(
        `INSERT INTO contract_signatures
           (business_id, envelope_id, signer_id, document_version_id, slot_id, full_name,
            drawn_image, ip_address, user_agent, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.business_id,
          row.envelope_id,
          row.signer_id,
          row.version_id,
          signer.slot_id,
          fullName,
          drawn || null,
          truncateIp(input.ip),
          (input.userAgent ?? "").slice(0, 300),
          row.version_hash,
        ],
      );
      await query(
        `UPDATE contract_signers
            SET status = 'signed', verified_at = now(), signed_at = now(), updated_at = now()
          WHERE id = $1`,
        [row.signer_id],
      );
      await appendEvent(
        row.business_id,
        row.envelope_id,
        "signed",
        { slot: signer.slot_id, version: row.version_number, contentHash: row.version_hash },
        row.signer_id,
      );

      const after = await signersOf(row.envelope_id);
      const progress = signingProgress(after);
      const status: ContractEnvelopeStatus = progress.complete ? "completed" : "partially_signed";
      const { rowCount } = await query(
        `UPDATE contract_signing_envelopes
            SET status = $3, completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
                updated_at = now()
          WHERE id = $1 AND business_id = $2 AND status IN ('sent', 'partially_signed')`,
        [row.envelope_id, row.business_id, status],
      );
      if (!rowCount) throw new WorkspaceError("signing_envelope_not_live");
      if (progress.complete) {
        // Revoke the remaining links: everybody has signed, so the capability
        // has no purpose left and should not stay live until it expires.
        await query(
          `UPDATE contract_invitations SET revoked_at = now()
            WHERE envelope_id = $1 AND revoked_at IS NULL`,
          [row.envelope_id],
        );
        await appendEvent(row.business_id, row.envelope_id, "envelope_completed", {
          version: row.version_number,
          contentHash: row.version_hash,
        });
      }
      return { status, progress, after };
    });

    // Sequential: the next signer's turn starts now, and their link is sent
    // here (after the signature is committed, never before).
    if (!result.progress.complete && row.signing_mode === "sequential") {
      await advanceSequential(row, result.after);
    }

    return {
      signedAt: new Date().toISOString(),
      contentHash: row.version_hash,
      version: row.version_number,
      envelopeStatus: result.status,
      completed: result.progress.complete,
    };
  });
}

async function advanceSequential(row: TokenRow, signers: ContractSigner[]): Promise<void> {
  const pending = signers
    .filter((signer) => signer.required && signer.status !== "signed" && signer.status !== "declined")
    .sort((a, b) => a.signOrder - b.signOrder)[0];
  if (!pending) return;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM contract_invitations WHERE signer_id = $1 AND revoked_at IS NULL`,
    [pending.id],
  );
  if (rows[0]) return;
  const expiresAt = new Date(Date.now() + DEFAULT_INVITATION_DAYS * 24 * 60 * 60 * 1000);
  const owner: WorkspaceOwner = {
    businessId: row.business_id,
    actorUserId: `signer:${row.signer_id}`,
    actorName: "signing",
  };
  const issued = await issueInvitations(owner, row.envelope_id, [{ id: pending.id, full_name: pending.fullName }], expiresAt);
  await appendEvent(row.business_id, row.envelope_id, "invitation_rotated", { channel: "sms" }, pending.id);
  await deliverIssued(owner, row.envelope_id, issued, {
    id: row.contract_id,
    title: row.contract_title,
  } as WorkspaceContract, originFromEnv());
}

function originFromEnv(): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : "";
}

export async function declineSigningSession(
  token: string,
  input: { reason?: unknown } & ClientFacts,
): Promise<void> {
  const row = await resolveToken(token);
  if (!row) throw new WorkspaceError("invalid_link");
  return withTenant(row.business_id, async () => {
    if (row.invitation_revoked_at) throw new WorkspaceError("link_revoked");
    if (row.signer_signed_at) throw new WorkspaceError("signer_already_signed");
    if (row.envelope_status !== "sent" && row.envelope_status !== "partially_signed") {
      throw new WorkspaceError("signing_envelope_not_live");
    }
    const reason = String(input.reason ?? "").trim().slice(0, 500);
    await query(
      `UPDATE contract_signers
          SET status = 'declined', declined_at = now(), decline_reason = $2, updated_at = now()
        WHERE id = $1 AND status <> 'signed'`,
      [row.signer_id, reason],
    );
    await query(
      `UPDATE contract_signing_envelopes
          SET status = 'declined', updated_at = now()
        WHERE id = $1 AND status IN ('sent', 'partially_signed')`,
      [row.envelope_id],
    );
    await query(
      `UPDATE contract_invitations SET revoked_at = now()
        WHERE envelope_id = $1 AND revoked_at IS NULL`,
      [row.envelope_id],
    );
    await appendEvent(
      row.business_id,
      row.envelope_id,
      "declined",
      { reason: reason.slice(0, 200), userAgent: (input.userAgent ?? "").slice(0, 200) },
      row.signer_id,
    );
  });
}

/** The receipt a signer can keep: their own view of a completed signature. */
export async function signingReceipt(
  token: string,
): Promise<{ fullName: string; signedAt: string; contentHash: string; version: number; slots: number } | null> {
  const row = await resolveToken(token);
  if (!row) return null;
  return withTenant(row.business_id, async () => {
    const { rows } = await query<{ full_name: string; signed_at: Date; content_hash: string }>(
      `SELECT full_name, signed_at, content_hash FROM contract_signatures
        WHERE signer_id = $1 AND business_id = $2`,
      [row.signer_id, row.business_id],
    );
    const signature = rows[0];
    if (!signature) return null;
    return {
      fullName: signature.full_name,
      signedAt: signature.signed_at.toISOString(),
      contentHash: signature.content_hash,
      version: row.version_number,
      slots: signatureSlots(normalizeContractContent(row.version_content)).length,
    };
  });
}
