/**
 * Issue #984 — the support companion's pure vocabulary.
 *
 * State machines, fixed module/operation catalogs, bounded lifetimes and
 * Persian labels shared by the server services, the API routes and the
 * superadmin ticket workspace. Framework-free (no db, no next/*) so the
 * drawer components import the same words the services enforce.
 *
 * Nothing here grants authority: every transition is re-checked against the
 * live ticket/installation/operator scope by the service that performs it.
 */

// ── Bounded lifetimes ──────────────────────────────────────────────────────

/** Default on-site token redemption window (amendment §3). */
export const SUPPORT_TOKEN_REDEMPTION_MINUTES = 30;
/** Absolute ceiling for any on-site token validity window. */
export const SUPPORT_TOKEN_MAX_MINUTES = 8 * 60;
/** Default remote-assistance session length; max 60 per consent. */
export const SUPPORT_SESSION_DEFAULT_MINUTES = 15;
export const SUPPORT_SESSION_MAX_MINUTES = 60;
/** A capture/input lease dies this fast without renewal. */
export const SUPPORT_LEASE_SECONDS = 30;
/** Diagnostic requests expire when the customer never opens the companion. */
export const SUPPORT_REQUEST_DEFAULT_MINUTES = 24 * 60;

// ── Diagnostic modules (fixed catalog — no arbitrary collectors) ───────────

export const SUPPORT_DIAGNOSTIC_MODULES = [
  "startup",
  "runtime",
  "storage",
  "database",
  "schema",
  "backup",
  "connectivity",
  "sync",
  "certificates",
  "gateway",
] as const;
export type SupportDiagnosticModule = (typeof SUPPORT_DIAGNOSTIC_MODULES)[number];

export const SUPPORT_DIAGNOSTIC_MODULE_LABELS: Record<SupportDiagnosticModule, string> = {
  startup: "راه‌اندازی",
  runtime: "محیط اجرا",
  storage: "حافظه و دسترسی",
  database: "پایگاه داده",
  schema: "نسخه و مهاجرت‌ها",
  backup: "پشتیبان‌گیری",
  connectivity: "اتصال اینترنت و ابر",
  sync: "همگام‌سازی",
  certificates: "گواهی‌ها",
  gateway: "درگاه‌ها",
};

export function isSupportDiagnosticModule(value: unknown): value is SupportDiagnosticModule {
  return typeof value === "string" && (SUPPORT_DIAGNOSTIC_MODULES as readonly string[]).includes(value);
}

/** Normalises a requested module list: unknown entries are dropped, never executed. */
export function normalizeSupportModules(values: unknown): SupportDiagnosticModule[] {
  if (!Array.isArray(values)) return [...SUPPORT_DIAGNOSTIC_MODULES];
  const cleaned = values.filter(isSupportDiagnosticModule);
  return cleaned.length > 0 ? [...new Set(cleaned)] : [...SUPPORT_DIAGNOSTIC_MODULES];
}

// ── Operations a support authorization may carry ────────────────────────────

export const SUPPORT_OPERATIONS = [
  "diagnostics.run",
  "report.upload",
  "repair.propose",
  "repair.execute",
  "remote.view",
  "remote.control",
  "ai.assist",
] as const;
export type SupportOperation = (typeof SUPPORT_OPERATIONS)[number];

export const SUPPORT_OPERATION_LABELS: Record<SupportOperation, string> = {
  "diagnostics.run": "اجرای بررسی‌ها",
  "report.upload": "ارسال گزارش",
  "repair.propose": "پیشنهاد تعمیر",
  "repair.execute": "اجرای تعمیر",
  "remote.view": "مشاهده راه‌دور",
  "remote.control": "کنترل راه‌دور",
  "ai.assist": "هوش پشتیبانی",
};

export function isSupportOperation(value: unknown): value is SupportOperation {
  return typeof value === "string" && (SUPPORT_OPERATIONS as readonly string[]).includes(value);
}

// ── Diagnostic request / run states ─────────────────────────────────────────

export const SUPPORT_REQUEST_STATES = [
  "pending",
  "delivered",
  "opened",
  "consented",
  "declined",
  "running",
  "partial",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export type SupportRequestState = (typeof SUPPORT_REQUEST_STATES)[number];

export const SUPPORT_REQUEST_STATE_LABELS: Record<SupportRequestState, string> = {
  pending: "در انتظار مشتری",
  delivered: "تحویل شد",
  opened: "باز شد",
  consented: "رضایت داده شد",
  declined: "رد شد",
  running: "در حال اجرا",
  partial: "ناقص",
  completed: "تکمیل شد",
  failed: "ناموفق",
  cancelled: "لغو شد",
  expired: "منقضی شد",
};

/** Terminal request states: a replayed completion cannot revive them. */
const TERMINAL_REQUEST_STATES: ReadonlySet<string> = new Set([
  "declined",
  "partial",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export function isSupportRequestState(value: unknown): value is SupportRequestState {
  return typeof value === "string" && (SUPPORT_REQUEST_STATES as readonly string[]).includes(value);
}

export function isTerminalRequestState(state: SupportRequestState): boolean {
  return TERMINAL_REQUEST_STATES.has(state);
}

export const SUPPORT_RUN_STATES = [
  "running",
  "partial",
  "completed",
  "failed",
  "cancelled",
  "declined",
] as const;
export type SupportRunState = (typeof SUPPORT_RUN_STATES)[number];

export const SUPPORT_RUN_STATE_LABELS: Record<SupportRunState, string> = {
  running: "در حال اجرا",
  partial: "ناقص",
  completed: "تکمیل شد",
  failed: "ناموفق",
  cancelled: "لغو شد",
  declined: "رد شد",
};

export function isSupportRunState(value: unknown): value is SupportRunState {
  return typeof value === "string" && (SUPPORT_RUN_STATES as readonly string[]).includes(value);
}

export const SUPPORT_UPLOAD_STATES = ["local_only", "not_sent", "uploading", "received", "failed"] as const;
export type SupportUploadState = (typeof SUPPORT_UPLOAD_STATES)[number];

export const SUPPORT_UPLOAD_STATE_LABELS: Record<SupportUploadState, string> = {
  local_only: "فقط محلی",
  not_sent: "ارسال نشد",
  uploading: "در حال ارسال",
  received: "دریافت شد",
  failed: "خطای ارسال",
};

// ── Repair catalog / runs ───────────────────────────────────────────────────

export const SUPPORT_REPAIR_RISKS = ["low", "medium", "high"] as const;
export type SupportRepairRisk = (typeof SUPPORT_REPAIR_RISKS)[number];

export const SUPPORT_REPAIR_RISK_LABELS: Record<SupportRepairRisk, string> = {
  low: "کم‌خطر",
  medium: "میان‌خطر",
  high: "پرخطر",
};

export function isSupportRepairRisk(value: unknown): value is SupportRepairRisk {
  return typeof value === "string" && (SUPPORT_REPAIR_RISKS as readonly string[]).includes(value);
}

export const SUPPORT_REPAIR_RUN_STATES = [
  "proposed",
  "dry_run_ready",
  "awaiting_approval",
  "authorized",
  "executing",
  "verifying",
  "succeeded",
  "rolled_back",
  "failed",
  "recovery_required",
  "declined",
  "blocked",
  "cancelled",
] as const;
export type SupportRepairRunState = (typeof SUPPORT_REPAIR_RUN_STATES)[number];

export const SUPPORT_REPAIR_RUN_STATE_LABELS: Record<SupportRepairRunState, string> = {
  proposed: "پیشنهاد شد",
  dry_run_ready: "پیش‌نمایش آماده",
  awaiting_approval: "در انتظار تأیید",
  authorized: "مجاز شد",
  executing: "در حال اجرا",
  verifying: "در حال راستی‌آزمایی",
  succeeded: "موفق و تأییدشده",
  rolled_back: "بازگردانده شد",
  failed: "ناموفق",
  recovery_required: "نیاز به بازیابی",
  declined: "رد شد",
  blocked: "مسدود شد",
  cancelled: "لغو شد",
};

const TERMINAL_REPAIR_RUN_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "rolled_back",
  "failed",
  "recovery_required",
  "declined",
  "blocked",
  "cancelled",
]);

export function isSupportRepairRunState(value: unknown): value is SupportRepairRunState {
  return typeof value === "string" && (SUPPORT_REPAIR_RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalRepairRunState(state: SupportRepairRunState): boolean {
  return TERMINAL_REPAIR_RUN_STATES.has(state);
}

/**
 * The repair run state graph (epic §11). Execution (`executing`) is reachable
 * only from `authorized`, and success only from `verifying` — a companion can
 * never jump a freshly proposed run to executing, nor invent success.
 * `blocked` (drift/precondition failure) and `cancelled` (Stop) are reachable
 * from every live state; terminal states have no outgoing edges.
 */
const REPAIR_RUN_TRANSITIONS: Record<string, readonly string[]> = {
  proposed: ["dry_run_ready", "awaiting_approval", "authorized", "declined", "blocked", "cancelled"],
  dry_run_ready: ["awaiting_approval", "authorized", "declined", "blocked", "cancelled"],
  awaiting_approval: ["authorized", "declined", "blocked", "cancelled"],
  authorized: ["executing", "declined", "blocked", "cancelled"],
  executing: ["verifying", "failed", "rolled_back", "recovery_required", "blocked", "cancelled"],
  verifying: ["succeeded", "failed", "rolled_back", "recovery_required", "blocked"],
};

export function isLegalRepairRunTransition(
  from: SupportRepairRunState,
  to: SupportRepairRunState,
): boolean {
  if (from === to) return false;
  return REPAIR_RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Assistance sessions ─────────────────────────────────────────────────────

export const SUPPORT_ASSISTANCE_CAPS = ["view", "control", "elevation"] as const;
export type SupportAssistanceCap = (typeof SUPPORT_ASSISTANCE_CAPS)[number];

export const SUPPORT_ASSISTANCE_CAP_LABELS: Record<SupportAssistanceCap, string> = {
  view: "مشاهده",
  control: "کنترل (ورودی)",
  elevation: "ارتقای سیستمی",
};

export function isSupportAssistanceCap(value: unknown): value is SupportAssistanceCap {
  return typeof value === "string" && (SUPPORT_ASSISTANCE_CAPS as readonly string[]).includes(value);
}

export const SUPPORT_ASSISTANCE_STATES = [
  "requested",
  "awaiting_local_consent",
  "approved",
  "connecting",
  "active_view",
  "active_control",
  "ended",
  "revoked",
  "expired",
  "failed",
] as const;
export type SupportAssistanceState = (typeof SUPPORT_ASSISTANCE_STATES)[number];

export const SUPPORT_ASSISTANCE_STATE_LABELS: Record<SupportAssistanceState, string> = {
  requested: "درخواست شد",
  awaiting_local_consent: "در انتظار رضایت محلی",
  approved: "تأیید شد",
  connecting: "در حال اتصال",
  active_view: "مشاهده فعال",
  active_control: "کنترل فعال",
  ended: "پایان یافت",
  revoked: "باطل شد",
  expired: "منقضی شد",
  failed: "ناموفق",
};

const TERMINAL_ASSISTANCE_STATES: ReadonlySet<string> = new Set(["ended", "revoked", "expired", "failed"]);

export function isSupportAssistanceState(value: unknown): value is SupportAssistanceState {
  return typeof value === "string" && (SUPPORT_ASSISTANCE_STATES as readonly string[]).includes(value);
}

export function isTerminalAssistanceState(state: SupportAssistanceState): boolean {
  return TERMINAL_ASSISTANCE_STATES.has(state);
}

export function isLiveAssistanceState(state: SupportAssistanceState): boolean {
  return state === "active_view" || state === "active_control";
}

// ── Access tokens ───────────────────────────────────────────────────────────

export const SUPPORT_TOKEN_PURPOSES = ["online_code", "offline_onsite"] as const;
export type SupportTokenPurpose = (typeof SUPPORT_TOKEN_PURPOSES)[number];

export const SUPPORT_TOKEN_PURPOSE_LABELS: Record<SupportTokenPurpose, string> = {
  online_code: "کد یک‌بارمصرف آنلاین",
  offline_onsite: "توکن امضاشده حضوری",
};

export function isSupportTokenPurpose(value: unknown): value is SupportTokenPurpose {
  return typeof value === "string" && (SUPPORT_TOKEN_PURPOSES as readonly string[]).includes(value);
}

export const SUPPORT_TOKEN_STATES = ["pending", "redeemed", "consumed", "expired", "revoked"] as const;
export type SupportTokenState = (typeof SUPPORT_TOKEN_STATES)[number];

export const SUPPORT_TOKEN_STATE_LABELS: Record<SupportTokenState, string> = {
  pending: "در انتظار",
  redeemed: "بازخرید شد",
  consumed: "مصرف شد",
  expired: "منقضی شد",
  revoked: "باطل شد",
};

// ── Consent subjects ────────────────────────────────────────────────────────

export const SUPPORT_CONSENT_SUBJECTS = [
  "diagnostics",
  "repair",
  "remote_view",
  "remote_control",
  "support_ai",
] as const;
export type SupportConsentSubject = (typeof SUPPORT_CONSENT_SUBJECTS)[number];

export const SUPPORT_CONSENT_SUBJECT_LABELS: Record<SupportConsentSubject, string> = {
  diagnostics: "بررسی تشخیصی",
  repair: "تعمیر",
  remote_view: "مشاهده راه‌دور",
  remote_control: "کنترل راه‌دور",
  support_ai: "هوش پشتیبانی",
};

export function isSupportConsentSubject(value: unknown): value is SupportConsentSubject {
  return typeof value === "string" && (SUPPORT_CONSENT_SUBJECTS as readonly string[]).includes(value);
}

export const SUPPORT_CONSENT_DECISIONS = ["granted", "denied", "revoked", "expired"] as const;
export type SupportConsentDecision = (typeof SUPPORT_CONSENT_DECISIONS)[number];

// ── Support AI ──────────────────────────────────────────────────────────────

/**
 * The fixed Support AI tool allowlist. There is intentionally no shell, SQL
 * or code-generation tool to grant: the model can read redacted evidence,
 * request bounded diagnostics, and *propose* catalog repairs. Execution
 * always happens at the operator-approved action boundary, outside the model.
 */
export const SUPPORT_AI_TOOLS = [
  "support.evidence.read",
  "support.diagnostics.request",
  "support.repair.propose",
  "support.report.summarize",
] as const;
export type SupportAiTool = (typeof SUPPORT_AI_TOOLS)[number];

export function isSupportAiTool(value: unknown): value is SupportAiTool {
  return typeof value === "string" && (SUPPORT_AI_TOOLS as readonly string[]).includes(value);
}

/**
 * Named Support AI model profiles. Aliases resolve through the canonical
 * LiteLLM gateway configuration (`ai-gateway.ts` owns routing); advanced
 * profiles are selectable only when published via `support.ai.configure`.
 * Tenant presets are never mutated to obtain support-only tools.
 */
export const SUPPORT_AI_PROFILES = ["support-default", "support-advanced", "support-research"] as const;
export type SupportAiProfile = (typeof SUPPORT_AI_PROFILES)[number];

export const SUPPORT_AI_PROFILE_LABELS: Record<SupportAiProfile, string> = {
  "support-default": "پشتیبانی استاندارد",
  "support-advanced": "پشتیبانی پیشرفته",
  "support-research": "پژوهش پشتیبانی",
};

export function isSupportAiProfile(value: unknown): value is SupportAiProfile {
  return typeof value === "string" && (SUPPORT_AI_PROFILES as readonly string[]).includes(value);
}
