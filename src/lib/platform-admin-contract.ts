/**
 * The single request contract for superadmin management (audit F01).
 *
 * Both the console page and `/api/platform/admins` import these types and
 * parsers, so the client can only send shapes the server accepts:
 *
 *   - POST  /api/platform/admins        → create an administrator (invite flow).
 *   - PATCH /api/platform/admins        → `action` one of
 *       `update` (name / role / active state),
 *       `revoke_sessions`,
 *       `reset_password` (issues a one-time reset/activation link).
 *
 * Every existing-admin request names its target as `adminId`. There is no
 * initial-password field: the invited operator establishes their own password
 * through the one-time link, so an administrator never knows a credential.
 *
 * Pure and client-safe (no database or server imports).
 */
import { PLATFORM_ADMIN_ROLES, type PlatformAdminRole } from "./platform-admin";

export const PLATFORM_ADMIN_ACTIONS = ["update", "revoke_sessions", "reset_password"] as const;
export type PlatformAdminAction = (typeof PLATFORM_ADMIN_ACTIONS)[number];

/** Actions that change access and therefore require recent authentication. */
export const PLATFORM_ADMIN_SENSITIVE_ACTIONS: readonly PlatformAdminAction[] = [
  "update",
  "revoke_sessions",
  "reset_password",
];

export interface PlatformAdminCreateRequest {
  email: string;
  fullName: string;
  role: PlatformAdminRole;
}

export type PlatformAdminUpdateRequest =
  | {
      action: "update";
      adminId: string;
      fullName?: string;
      role?: PlatformAdminRole;
      isActive?: boolean;
    }
  | { action: "revoke_sessions"; adminId: string }
  | { action: "reset_password"; adminId: string };

export type PlatformAdminContractError =
  | "bad_request"
  | "invalid_action"
  | "invalid_role"
  | "missing_fields"
  | "invalid_email"
  | "nothing_to_update";

export type PlatformAdminParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PlatformAdminContractError; field?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlatformAdminAction(value: unknown): value is PlatformAdminAction {
  return typeof value === "string" && (PLATFORM_ADMIN_ACTIONS as readonly string[]).includes(value);
}

function isPlatformAdminRole(value: unknown): value is PlatformAdminRole {
  return typeof value === "string" && (PLATFORM_ADMIN_ROLES as readonly string[]).includes(value);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parsePlatformAdminCreate(
  body: unknown,
): PlatformAdminParseResult<PlatformAdminCreateRequest> {
  if (!isRecord(body)) return { ok: false, error: "bad_request" };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (!email) return { ok: false, error: "missing_fields", field: "email" };
  if (!fullName) return { ok: false, error: "missing_fields", field: "fullName" };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "invalid_email", field: "email" };
  if (!isPlatformAdminRole(body.role)) return { ok: false, error: "invalid_role", field: "role" };
  return { ok: true, value: { email, fullName, role: body.role } };
}

export function parsePlatformAdminUpdate(
  body: unknown,
): PlatformAdminParseResult<PlatformAdminUpdateRequest> {
  if (!isRecord(body)) return { ok: false, error: "bad_request" };
  if (!isPlatformAdminAction(body.action)) return { ok: false, error: "invalid_action", field: "action" };
  const adminId = typeof body.adminId === "string" ? body.adminId.trim() : "";
  if (!adminId) return { ok: false, error: "bad_request", field: "adminId" };

  if (body.action === "revoke_sessions" || body.action === "reset_password") {
    return { ok: true, value: { action: body.action, adminId } };
  }

  const value: PlatformAdminUpdateRequest = { action: "update", adminId };
  if (body.fullName !== undefined) {
    if (typeof body.fullName !== "string" || !body.fullName.trim()) {
      return { ok: false, error: "missing_fields", field: "fullName" };
    }
    value.fullName = body.fullName.trim();
  }
  if (body.role !== undefined) {
    if (!isPlatformAdminRole(body.role)) return { ok: false, error: "invalid_role", field: "role" };
    value.role = body.role;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return { ok: false, error: "bad_request", field: "isActive" };
    value.isActive = body.isActive;
  }
  if (value.fullName === undefined && value.role === undefined && value.isActive === undefined) {
    return { ok: false, error: "nothing_to_update" };
  }
  return { ok: true, value };
}

/** Operator-facing Persian text for every contract error. */
export function platformAdminContractMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    bad_request: "درخواست نامعتبر است.",
    invalid_action: "عملیات انتخاب‌شده پشتیبانی نمی‌شود.",
    invalid_role: "نقش انتخاب‌شده معتبر نیست.",
    missing_fields: "نام و ایمیل مدیر الزامی است.",
    invalid_email: "ایمیل واردشده معتبر نیست.",
    nothing_to_update: "هیچ تغییری برای ذخیره وجود ندارد.",
    email_exists: "این ایمیل قبلاً برای مدیر دیگری ثبت شده است.",
    email_taken: "این ایمیل قبلاً برای مدیر دیگری ثبت شده است.",
    last_platform_owner: "نمی‌توان آخرین مالک فعال سکو را غیرفعال کرد یا نقش او را تغییر داد.",
    cannot_deactivate_self: "نمی‌توانید حساب خودتان را غیرفعال کنید.",
    recent_auth_required: "برای انجام این عملیات حساس، ابتدا هویت خود را مجدداً تأیید کنید.",
    not_found: "مدیر موردنظر پیدا نشد.",
  };
  return (code && map[code]) || "عملیات انجام نشد. دوباره تلاش کنید.";
}
