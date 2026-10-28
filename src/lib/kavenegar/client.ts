/**
 * Issue #902 — Kavenegar **customer management** adapter, the pure half.
 *
 * Phase 37's `messaging/providers/kavenegar.ts` already owns the *sending* half
 * of one account. This module owns the master/child API documented at
 * <https://kavenegar.com/customers.html>, which is a different API with a
 * different envelope and a different error table:
 *
 *   GET  https://api.kavenegar.com/v1/{MASTER_KEY}/client/add.json
 *        ?localid=<our id>&Username=<u>&password=<p>&Fullname=<n>
 *        &Status=2&Mininumallowedcredit=<rial>&Planid=<id>&Lines=<a,b>
 *   GET  …/client/fetchbylocalid.json?Localid=<our id>
 *   GET  …/verify/templatelist.json?apiKey=<child key>&page=1
 *
 * The reply envelope (verified against the provider's own documented examples,
 * which are recorded as fixtures in `client.test.ts`) puts the result in
 * `return` and the PAYLOAD in a **top-level `entries`**:
 *
 *   { "return": { "status": 200, "message": "تایید شد" },
 *     "entries": { "apikey": "…", "localid": "…", "remaincredit": 25000, … } }
 *
 * `entries` is an object for the single-record methods and an array for
 * `client/list`; template listing adds `metadata` with pagination. Reading
 * `return.entries` — which the Phase 37 send parser did — therefore always
 * yielded nothing. This module reads the documented shape and still tolerates
 * the legacy nesting, so a recorded fixture from either era can be replayed.
 *
 * Nothing here touches the network (that is `rest.ts`), and nothing here may
 * keep a provider credential-adjacent field: `pwdhashed` is dropped during
 * normalisation rather than merely ignored by callers, and every URL builder
 * is paired with `redactKavenegarUrl` for logging.
 */
import type { ManagedServiceFaultCode } from "../managed-services/contract";

export const KAVENEGAR_API_BASE = "https://api.kavenegar.com/v1";

/** Provider child status, normalised from its own `Approved`/`PendingReview`/`Removed`. */
export type KavenegarChildStatus = "approved" | "pending" | "removed" | "unknown";

/**
 * A child account as the platform needs it. Provider credential-adjacent
 * fields (`pwdhashed`) and contact PII (`mobile`) are deliberately absent: the
 * platform provisions a panel login it never uses, and does not mirror the
 * provider's copy of a phone number.
 */
export interface KavenegarChildAccount {
  /** The child API key. Secret — encrypted before it is stored, never logged. */
  apiKey: string;
  localId: string;
  username: string;
  fullName: string;
  status: KavenegarChildStatus;
  /** Provider `remaincredit`, in Rial. Internal pre-funding only. */
  remainCreditRial: number;
  smsFarsiCostRial: number | null;
  smsEnglishCostRial: number | null;
  pricingName: string | null;
  minAllowedCreditRial: number | null;
  assignedLines: string[];
  expireAtUnix: number | null;
  lastLoginAtUnix: number | null;
}

export interface KavenegarTemplate {
  templateId: string;
  name: string;
  /** SMS body (`textmessage` or the newer `smsMessage`). */
  smsMessage: string;
  approvalStatus: "approved" | "pending" | "rejected" | "unknown";
}

export interface KavenegarEnvelope<T> {
  status: number;
  message: string;
  entries: T[];
  /** Template list pagination; empty for the client methods. */
  metadata: Record<string, string>;
  /** Which documented shape the payload arrived in — useful in a fixture test. */
  entriesShape: "object" | "array" | "none" | "return_nested";
}

export class KavenegarParseError extends Error {
  constructor(readonly reason: "invalid_json" | "invalid_envelope") {
    super(`kavenegar_response_${reason}`);
    this.name = "KavenegarParseError";
  }
}

/**
 * Parse the documented envelope and map each entry.
 *
 * `entries` may be an object (single record), an array (list), absent (delete
 * or a validation failure) or — legacy — nested under `return`. All four are
 * handled so a caller never has to know which method it called.
 */
export function parseKavenegarEnvelope<T>(
  body: string,
  mapEntry: (raw: Record<string, unknown>) => T,
): KavenegarEnvelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new KavenegarParseError("invalid_json");
  }
  if (!parsed || typeof parsed !== "object") throw new KavenegarParseError("invalid_envelope");

  const root = parsed as Record<string, unknown>;
  const inner = root.return;
  if (!inner || typeof inner !== "object") throw new KavenegarParseError("invalid_envelope");
  const result = inner as Record<string, unknown>;

  const status = Number(result.status ?? 0);
  const message = String(result.message ?? "");

  let payload: unknown = root.entries;
  let entriesShape: KavenegarEnvelope<T>["entriesShape"] = "none";
  if (payload !== undefined) {
    entriesShape = Array.isArray(payload) ? "array" : "object";
  } else if (result.entries !== undefined) {
    payload = result.entries;
    entriesShape = "return_nested";
  }

  const rawEntries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? [payload]
      : [];

  const entries = rawEntries.map((entry) =>
    mapEntry((entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>),
  );

  const metadata: Record<string, string> = {};
  const meta = root.metadata ?? result.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      metadata[key] = String(value ?? "");
    }
  }

  return { status, message, entries, metadata, entriesShape };
}

/** Case-insensitive field read: the provider is inconsistent about key casing. */
function pick(raw: Record<string, unknown>, key: string): unknown {
  if (key in raw) return raw[key];
  const lower = key.toLowerCase();
  for (const [candidate, value] of Object.entries(raw)) {
    if (candidate.toLowerCase() === lower) return value;
  }
  return undefined;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeChildStatus(value: unknown): KavenegarChildStatus {
  const text = stringValue(value).trim().toLowerCase();
  if (!text) return "unknown";
  if (text.includes("approv")) return "approved";
  if (text.includes("pend")) return "pending";
  if (text.includes("remov") || text.includes("reject") || text.includes("deactiv") || text === "0") {
    return "removed";
  }
  if (text === "1" || text === "2") return "approved";
  return "unknown";
}

/** Map one `client/*` entry into the platform's child-account shape. */
export function mapChildAccount(raw: Record<string, unknown>): KavenegarChildAccount {
  // `pwdhashed` and `mobile` are intentionally not copied: a hashed panel
  // password is a credential-adjacent value and a mirrored mobile number is PII
  // this platform does not need.
  const lines = stringValue(pick(raw, "assignedlines") ?? pick(raw, "lines"))
    .split(",")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    apiKey: stringValue(pick(raw, "apikey")),
    localId: stringValue(pick(raw, "localid")),
    username: stringValue(pick(raw, "username")),
    fullName: stringValue(pick(raw, "fullname")),
    status: normalizeChildStatus(pick(raw, "status")),
    remainCreditRial: numberValue(pick(raw, "remaincredit")) ?? 0,
    smsFarsiCostRial: numberValue(pick(raw, "smsfarsicost")),
    smsEnglishCostRial: numberValue(pick(raw, "smsenglishcost")),
    pricingName: stringValue(pick(raw, "pricingname")) || null,
    minAllowedCreditRial: numberValue(pick(raw, "mininumallowedcredit")),
    assignedLines: lines,
    expireAtUnix: numberValue(pick(raw, "expiredate")),
    lastLoginAtUnix: numberValue(pick(raw, "lastlogindate")),
  };
}

export function normalizeTemplateStatus(value: unknown): KavenegarTemplate["approvalStatus"] {
  const text = stringValue(value).trim().toLowerCase();
  if (text.includes("approv")) return "approved";
  if (text.includes("pend")) return "pending";
  if (text.includes("reject")) return "rejected";
  return "unknown";
}

export function mapTemplate(raw: Record<string, unknown>): KavenegarTemplate {
  return {
    templateId: stringValue(pick(raw, "templateid") ?? pick(raw, "id")),
    name: stringValue(pick(raw, "name")),
    smsMessage: stringValue(pick(raw, "textmessage") ?? pick(raw, "smsmessage")),
    approvalStatus: normalizeTemplateStatus(pick(raw, "approvalstatus")),
  };
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

export type KavenegarErrorCode =
  | "ok"
  | "invalid_request"
  | "invalid_credentials"
  | "account_disabled"
  | "access_denied"
  | "provider_unavailable"
  | "rate_limited"
  | "insufficient_credit"
  | "invalid_recipient"
  | "invalid_sender"
  | "invalid_message"
  | "template_unavailable"
  | "not_found"
  | "duplicate_username"
  | "duplicate_localid"
  | "tariff_invalid"
  | "parent_expired"
  | "duplicate_contact"
  | "invalid_template"
  | "unknown";

export interface KavenegarClassification {
  ok: boolean;
  /** The adapter's decision — the queue never guesses. */
  retryable: boolean;
  code: KavenegarErrorCode;
  /** Provider-neutral fault for tenant copy; see managed-services/contract.ts. */
  fault: ManagedServiceFaultCode;
  /** English, for the operator log and the console. Never tenant copy. */
  operatorMessage: string;
}

const STATUS_TABLE: Record<number, Omit<KavenegarClassification, "ok">> = {
  400: { retryable: false, code: "invalid_request", fault: "provider_rejected", operatorMessage: "provider: incomplete request parameters" },
  401: { retryable: false, code: "account_disabled", fault: "service_suspended", operatorMessage: "provider: account disabled" },
  402: { retryable: false, code: "provider_unavailable", fault: "provider_rejected", operatorMessage: "provider: operation failed" },
  403: { retryable: false, code: "invalid_credentials", fault: "service_suspended", operatorMessage: "provider: master key or credentials rejected" },
  406: { retryable: false, code: "invalid_request", fault: "provider_rejected", operatorMessage: "provider: required parameter empty" },
  407: { retryable: false, code: "access_denied", fault: "provider_rejected", operatorMessage: "provider: access to this resource denied" },
  409: { retryable: true, code: "provider_unavailable", fault: "timeout", operatorMessage: "provider: server busy" },
  411: { retryable: false, code: "invalid_recipient", fault: "recipient_invalid", operatorMessage: "provider: invalid recipient" },
  412: { retryable: false, code: "invalid_sender", fault: "provider_rejected", operatorMessage: "provider: invalid sender line" },
  413: { retryable: false, code: "invalid_message", fault: "content_blocked", operatorMessage: "provider: message empty or too long" },
  414: { retryable: false, code: "invalid_request", fault: "provider_rejected", operatorMessage: "provider: too many records in one call" },
  417: { retryable: false, code: "invalid_request", fault: "provider_rejected", operatorMessage: "provider: invalid date" },
  418: { retryable: false, code: "insufficient_credit", fault: "platform_credit_exhausted", operatorMessage: "provider: insufficient credit on the sending account" },
  419: { retryable: false, code: "invalid_request", fault: "provider_rejected", operatorMessage: "provider: array lengths differ" },
  420: { retryable: false, code: "invalid_message", fault: "content_blocked", operatorMessage: "provider: links are restricted on this account" },
  424: { retryable: false, code: "template_unavailable", fault: "provider_rejected", operatorMessage: "provider: template missing or not approved" },
  449: { retryable: false, code: "not_found", fault: "provider_rejected", operatorMessage: "provider: no record matched" },
  451: { retryable: true, code: "rate_limited", fault: "rate_limited", operatorMessage: "provider: rate limited" },
  502: { retryable: false, code: "duplicate_username", fault: "provider_rejected", operatorMessage: "provider: username already taken" },
  503: { retryable: false, code: "duplicate_localid", fault: "provider_rejected", operatorMessage: "provider: local id already exists" },
  504: { retryable: false, code: "tariff_invalid", fault: "provider_rejected", operatorMessage: "provider: child tariff must not be cheaper than the parent" },
  505: { retryable: false, code: "parent_expired", fault: "service_suspended", operatorMessage: "provider: master account service expired" },
  506: { retryable: false, code: "tariff_invalid", fault: "provider_rejected", operatorMessage: "provider: tariff change refused (child credit above the allowed floor)" },
  507: { retryable: false, code: "duplicate_contact", fault: "provider_rejected", operatorMessage: "provider: mobile number already registered" },
  601: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: duplicate token in template" },
  602: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: template name already exists" },
  603: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: line cannot host a verification template" },
  703: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid template source type" },
  704: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid send method" },
  705: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid send priority" },
  706: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid template name" },
  707: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid template text" },
  708: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid voice template" },
  709: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid fallback window" },
  710: { retryable: false, code: "invalid_template", fault: "provider_rejected", operatorMessage: "provider: invalid template token" },
};

/**
 * Classify a `return.status`. Unknown non-200 statuses are treated as
 * transient: the alternative is permanently failing a send because the
 * supplier added a code, and a retry is bounded by the queue's attempt cap.
 */
export function classifyKavenegarStatus(status: number): KavenegarClassification {
  if (status === 200) {
    return { ok: true, retryable: false, code: "ok", fault: "unknown", operatorMessage: "provider: ok" };
  }
  return {
    ok: false,
    ...(STATUS_TABLE[status] ?? {
      retryable: true,
      code: "unknown",
      fault: "unknown",
      operatorMessage: `provider: unrecognised status ${status}`,
    }),
  };
}

/**
 * Error codes for which creating a child is worth retrying with a NEW username
 * (the provider's uniqueness rule is global, so a collision says nothing about
 * the business). Every other permanent failure needs an operator.
 */
export function isUsernameCollision(classification: KavenegarClassification): boolean {
  return classification.code === "duplicate_username";
}

/**
 * A `localid` collision is not a failure: it means an earlier create DID land
 * and its response was lost. The caller must recover with
 * `client/fetchbylocalid` before it ever retries `client/add`.
 */
export function isLocalIdCollision(classification: KavenegarClassification): boolean {
  return classification.code === "duplicate_localid";
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export interface KavenegarRequest {
  url: string;
  method: "GET" | "POST";
  params: Record<string, string>;
}

function clientUrl(apiKey: string, method: string): string {
  return `${KAVENEGAR_API_BASE}/${encodeURIComponent(apiKey)}/client/${method}.json`;
}

function verifyUrl(apiKey: string, method: string): string {
  return `${KAVENEGAR_API_BASE}/${encodeURIComponent(apiKey)}/verify/${method}.json`;
}

/** Provider `Status` values, verified against customers.html. */
export const KAVENEGAR_CHILD_STATUS = {
  disabled: "0",
  activeWithPanel: "1",
  /** Active for sending, panel login disabled — what a managed tenant gets. */
  activeNoPanel: "2",
} as const;

export interface AddChildAccountInput {
  masterApiKey: string;
  localId: string;
  username: string;
  password: string;
  fullName: string;
  /** Provider `Planid`. Omitted = the master account's default tariff. */
  planId?: number | null;
  /** `Mininumallowedcredit` — the provider's own spelling, sent verbatim. */
  minAllowedCreditRial: number;
  status?: string;
  lines?: string[];
  /** Rial. Zero by default: funding is a separate, audited operation. */
  initialCreditRial?: number;
  mobile?: string;
}

export function buildAddChildAccountRequest(input: AddChildAccountInput): KavenegarRequest {
  const params: Record<string, string> = {
    localid: input.localId,
    Username: input.username,
    password: input.password,
    Fullname: input.fullName,
    Status: input.status ?? KAVENEGAR_CHILD_STATUS.activeNoPanel,
    Mininumallowedcredit: String(Math.max(0, Math.trunc(input.minAllowedCreditRial))),
    // A managed child must never be able to spend the master's lines: the
    // platform assigns the lines it is willing to pay for.
    CanUseParentLines: "false",
  };
  if (input.planId !== undefined && input.planId !== null) params.Planid = String(input.planId);
  if (input.lines && input.lines.length > 0) params.Lines = input.lines.join(",");
  if (input.mobile) params.Mobile = input.mobile;
  if (input.initialCreditRial && input.initialCreditRial > 0) {
    params.Credit = String(Math.trunc(input.initialCreditRial));
  }
  return { url: clientUrl(input.masterApiKey, "add"), method: "POST", params };
}

export interface UpdateChildAccountInput {
  masterApiKey: string;
  /** Identifies the child. Required by the provider. */
  childApiKey: string;
  fullName?: string;
  username?: string;
  status?: string;
  minAllowedCreditRial?: number;
  lines?: string[];
  canUseParentLines?: boolean;
  /** Rial. Never sent for a routine identity sync. */
  expireAtUnix?: number;
}

export function buildUpdateChildAccountRequest(input: UpdateChildAccountInput): KavenegarRequest {
  const params: Record<string, string> = { Apikey: input.childApiKey };
  if (input.fullName !== undefined) params.Fullname = input.fullName;
  if (input.username !== undefined) params.Username = input.username;
  if (input.status !== undefined) params.Status = input.status;
  if (input.minAllowedCreditRial !== undefined) {
    params.MininumAllowedCredit = String(Math.max(0, Math.trunc(input.minAllowedCreditRial)));
  }
  if (input.lines !== undefined) params.Lines = input.lines.join(",");
  if (input.canUseParentLines !== undefined) {
    params.CanUseParentLines = input.canUseParentLines ? "true" : "false";
  }
  if (input.expireAtUnix !== undefined) params.ExpireDate = String(Math.trunc(input.expireAtUnix));
  return { url: clientUrl(input.masterApiKey, "update"), method: "POST", params };
}

export function buildFetchChildRequest(input: { masterApiKey: string; childApiKey: string }): KavenegarRequest {
  return {
    url: clientUrl(input.masterApiKey, "fetch"),
    method: "GET",
    params: { apikey: input.childApiKey },
  };
}

export function buildFetchChildByLocalIdRequest(input: {
  masterApiKey: string;
  localId: string;
}): KavenegarRequest {
  return {
    url: clientUrl(input.masterApiKey, "fetchbylocalid"),
    method: "GET",
    params: { Localid: input.localId },
  };
}

export function buildListChildrenRequest(input: { masterApiKey: string }): KavenegarRequest {
  return { url: clientUrl(input.masterApiKey, "list"), method: "GET", params: {} };
}

export function buildSetChildStatusRequest(input: {
  masterApiKey: string;
  childApiKey: string;
  status: string;
}): KavenegarRequest {
  return {
    url: clientUrl(input.masterApiKey, "setstatus"),
    method: "POST",
    params: { ApiKey: input.childApiKey, Status: input.status },
  };
}

export function buildRenewChildKeyRequest(input: {
  masterApiKey: string;
  childApiKey?: string;
  localId?: string;
}): KavenegarRequest {
  const params: Record<string, string> = {};
  if (input.childApiKey) params.apikey = input.childApiKey;
  if (input.localId) params.localid = input.localId;
  return { url: clientUrl(input.masterApiKey, "renewkey"), method: "POST", params };
}

export function buildChargeChildCreditRequest(input: {
  masterApiKey: string;
  childApiKey: string;
  /** Signed Rial: negative claws credit back. */
  creditRial: number;
  description?: string;
  /** Provider `vat` flag; default is whatever the provider does. */
  vat?: boolean;
}): KavenegarRequest {
  const params: Record<string, string> = {
    apikey: input.childApiKey,
    Credit: String(Math.trunc(input.creditRial)),
  };
  if (input.description) params.Desc = input.description;
  if (input.vat !== undefined) params.vat = input.vat ? "1" : "0";
  return { url: clientUrl(input.masterApiKey, "chargecredit"), method: "POST", params };
}

export interface AddTemplateInput {
  masterApiKey: string;
  /** Target child; omitted targets the master account itself. */
  childApiKey?: string;
  childLocalId?: string;
  name: string;
  textMessage: string;
  sourceType?: number;
  sendMethod?: number;
  fallBackMethod?: number;
  primaryLineNumber?: string;
  secondaryLineNumber?: string;
  switchTtl?: number;
  sourceUrl?: string;
  sourceName?: string;
}

export function buildAddTemplateRequest(input: AddTemplateInput): KavenegarRequest {
  const params: Record<string, string> = {
    name: input.name,
    sourceType: String(input.sourceType ?? 0),
    sendMethod: String(input.sendMethod ?? 1),
    textMessage: input.textMessage,
  };
  if (input.fallBackMethod !== undefined) params.fallBackMethod = String(input.fallBackMethod);
  if (input.primaryLineNumber) params.primaryLineNumber = input.primaryLineNumber;
  if (input.secondaryLineNumber) params.secondaryLineNumber = input.secondaryLineNumber;
  if (input.switchTtl !== undefined) params.switchTTL = String(input.switchTtl);
  if (input.sourceUrl) params.sourceUrl = input.sourceUrl;
  if (input.sourceName) params.sourceName = input.sourceName;
  if (input.childApiKey) params.apiKey = input.childApiKey;
  if (input.childLocalId) params.localId = input.childLocalId;
  return { url: verifyUrl(input.masterApiKey, "addtemplate"), method: "POST", params };
}

/**
 * `verify/updatetemplate` — revise a template the provider already holds.
 *
 * The documented contract differs from `addtemplate` in one way that matters
 * here: `templateId`, `sourceType`, `sendMethod` and `name` are ALL required,
 * and the reply echoes the template fields but **not** `approvalStatus`. An
 * edited template goes back to review, so the caller must treat a success as
 * "submitted", never as "approved" — see `submitLookupTemplate`.
 *
 * (`https://kavenegar.com/rest.html` §Verification Template → ۴. ویرایش الگو.)
 */
export interface UpdateTemplateInput {
  masterApiKey: string;
  templateId: number;
  name: string;
  /** Target child; omitted targets the master account itself. */
  childApiKey?: string;
  childLocalId?: string;
  sourceType?: number;
  sendMethod?: number;
  textMessage?: string;
  voiceMessage?: string;
  fallBackMethod?: number;
  primaryLineNumber?: string;
  secondaryLineNumber?: string;
  switchTtl?: number;
  sourceUrl?: string;
  sourceName?: string;
}

export function buildUpdateTemplateRequest(input: UpdateTemplateInput): KavenegarRequest {
  const params: Record<string, string> = {
    templateId: String(Math.trunc(input.templateId)),
    name: input.name,
    sourceType: String(input.sourceType ?? 0),
    sendMethod: String(input.sendMethod ?? 1),
  };
  if (input.textMessage !== undefined) params.textMessage = input.textMessage;
  if (input.voiceMessage !== undefined) params.voiceMessage = input.voiceMessage;
  if (input.fallBackMethod !== undefined) params.fallBackMethod = String(input.fallBackMethod);
  if (input.primaryLineNumber) params.primaryLineNumber = input.primaryLineNumber;
  if (input.secondaryLineNumber) params.secondaryLineNumber = input.secondaryLineNumber;
  if (input.switchTtl !== undefined) params.switchTTL = String(input.switchTtl);
  if (input.sourceUrl) params.sourceUrl = input.sourceUrl;
  if (input.sourceName) params.sourceName = input.sourceName;
  if (input.childApiKey) params.apiKey = input.childApiKey;
  if (input.childLocalId) params.localId = input.childLocalId;
  return { url: verifyUrl(input.masterApiKey, "updatetemplate"), method: "POST", params };
}

export function buildListTemplatesRequest(input: {
  masterApiKey: string;
  childApiKey?: string;
  childLocalId?: string;
  page?: number;
}): KavenegarRequest {
  const params: Record<string, string> = {};
  if (input.childApiKey) params.apiKey = input.childApiKey;
  if (input.childLocalId) params.localId = input.childLocalId;
  if (input.page !== undefined) params.page = String(Math.max(1, Math.trunc(input.page)));
  return { url: verifyUrl(input.masterApiKey, "templatelist"), method: "GET", params };
}

export function buildGetTemplateRequest(input: {
  masterApiKey: string;
  templateId: number;
  childApiKey?: string;
  childLocalId?: string;
}): KavenegarRequest {
  const params: Record<string, string> = { id: String(Math.trunc(input.templateId)) };
  if (input.childApiKey) params.apiKey = input.childApiKey;
  if (input.childLocalId) params.localId = input.childLocalId;
  return { url: verifyUrl(input.masterApiKey, "gettemplate"), method: "GET", params };
}

export function buildCloneTemplateRequest(input: {
  masterApiKey: string;
  newTemplateName: string;
  sourceTemplateId?: number;
  sourceTemplateName?: string;
  childApiKey?: string;
  childLocalId?: string;
}): KavenegarRequest {
  const params: Record<string, string> = { newTemplateName: input.newTemplateName };
  if (input.sourceTemplateId !== undefined) params.sourceTemplateId = String(input.sourceTemplateId);
  if (input.sourceTemplateName) params.sourceTemplateName = input.sourceTemplateName;
  if (input.childApiKey) params.apiKey = input.childApiKey;
  if (input.childLocalId) params.localId = input.childLocalId;
  return { url: verifyUrl(input.masterApiKey, "clonetemplate"), method: "POST", params };
}

export function buildDeleteTemplateRequest(input: {
  masterApiKey: string;
  templateId: number;
  childApiKey?: string;
  childLocalId?: string;
}): KavenegarRequest {
  const params: Record<string, string> = { id: String(Math.trunc(input.templateId)) };
  if (input.childApiKey) params.apiKey = input.childApiKey;
  if (input.childLocalId) params.localId = input.childLocalId;
  return { url: verifyUrl(input.masterApiKey, "deletetemplate"), method: "POST", params };
}

/**
 * Issue #902 §5 — one `verify/lookup` send.
 *
 * Unlike the customer-management calls, a lookup send is authenticated by the
 * **child's own key in the URL** (`/{key}/verify/lookup.json`): the message goes
 * out of the business's account, is billed to that business's provider credit,
 * and the master key never appears. That is why this builder takes no
 * `masterApiKey` — there is nothing here for the master to do.
 *
 * `template` is the derived provider name (`bm<8 hex>`), never the tenant's
 * title: `template-service.lookupTemplateName` is the single place that maps one
 * to the other, so a rename can never silently change which approved message
 * sends.
 */
export interface LookupSendInput {
  /** The child account's own API key. */
  apiKey: string;
  /** The provider template name, already derived and approved. */
  template: string;
  receptor: string;
  /** Positional token values: `tokens[0]` → `%token`, `[1]` → `%token2`. */
  tokens: string[];
  /** The child's assigned line, when the policy fixes one. */
  sender?: string | null;
}

/**
 * Iranian mobile numbers, as people and CRMs actually store them.
 *
 * A bad receptor is a billed provider failure (411), so the normalisation is
 * here rather than left to whatever a caller happened to type: `+98`, `0098`,
 * `98`, Persian digits and stray separators all have to become one canonical
 * `09xxxxxxxxx`.
 */
export function normalizeReceptor(value: string): string | null {
  const digits = String(value)
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[^0-9]/g, "")
    // `0098…` is the same subscriber as `+98…`: strip the international prefix
    // before deciding what the number is.
    .replace(/^0098/, "98");
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^989\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return null;
}

export function buildLookupSendRequest(input: LookupSendInput): KavenegarRequest {
  const params: Record<string, string> = {
    receptor: input.receptor,
    template: input.template,
  };
  // The provider's slot names, spelled the way its own substitution pass reads
  // them: `token`, `token2`, `token3`.
  input.tokens.forEach((value, index) => {
    params[index === 0 ? "token" : `token${index + 1}`] = value;
  });
  if (input.sender) params.sender = input.sender;
  return { url: verifyUrl(input.apiKey, "lookup"), method: "POST", params };
}

export interface LookupSendResult {
  /** The provider's message id, for support and delivery tracking. */
  messageId: string | null;
  /**
   * What the provider says the message cost, in rial. Null when it did not say
   * — the margin report prefers an honest null to a zero.
   */
  costRial: number | null;
  status: number | null;
}

export function mapLookupEntry(raw: Record<string, unknown>): LookupSendResult {
  const messageId = raw.messageid ?? raw.messageId ?? raw.id;
  const cost = Number(raw.cost);
  const status = Number(raw.status);
  return {
    messageId: messageId === undefined || messageId === null ? null : String(messageId),
    costRial: Number.isFinite(cost) && cost > 0 ? Math.round(cost) : null,
    status: Number.isFinite(status) ? status : null,
  };
}

/**
 * Strip the credential out of a provider URL before it reaches a log line.
 *
 * Three things can carry a secret: the master/child key in the path, the
 * `apikey`/`password`/`token` query parameters, and a `localid` that is a
 * business UUID (not a secret, but tenant-identifying — redacted for the same
 * reason a log line never needs it). Everything else is kept so the line is
 * still diagnosable.
 */
export function redactKavenegarUrl(url: string): string {
  return url
    .replace(/\/v1\/[^/?#\s]+/g, "/v1/REDACTED")
    .replace(/([?&](?:apikey|api_key|password|token|localid|locallid)=)[^&\s]*/gi, "$1REDACTED");
}
