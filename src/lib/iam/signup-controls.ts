/**
 * Issue #1388 — the runtime public-registration control.
 *
 * ## What this module owns
 *
 * One setting, read on every public signup entry point and written only by an
 * authorised Superadmin:
 *
 *  - **enable / disable public registration**, and
 *  - **a maintenance pause** with an optional Persian explanation.
 *
 * ## Precedence, stated once
 *
 *   1. **A stored row wins.** Once a Superadmin saves the control, it is the
 *      governing answer on every door. This is what lets an install whose
 *      environment never set `ALLOW_PUBLIC_SIGNUP` enable registration from the
 *      console, and it is audited (`signup.settings.update`).
 *   2. **No row means the environment gate.** An install that has never opened
 *      the console behaves exactly as before #1388: registration is enabled
 *      only when `ALLOW_PUBLIC_SIGNUP` is exactly `"true"`.
 *   3. **Unreadable or invalid means the environment gate too.** A missing
 *      table (an older schema), a database error, or a row whose shape does not
 *      validate is never guessed at: the deployment's own gate answers, and a
 *      failure is logged with no personal data. That fails safe for every
 *      existing deployment and never invents permission.
 *   4. **Maintenance narrows, never widens.** If maintenance is on, the door is
 *      closed even when registration is enabled — pausing is the explicit act.
 *
 * The public doors therefore distinguish two refusals: `signup_disabled`
 * (administrative or deployment gate) and `signup_maintenance` (a pause with
 * recovery guidance). Neither reveals a provider, a security control or an
 * internal reason.
 */
import { query, withoutTenantScope } from "../db";

/** Bound kept in step with the migration's CHECK. */
export const SIGNUP_MAINTENANCE_MESSAGE_MAX = 500;

export const DEFAULT_SIGNUP_MAINTENANCE_MESSAGE =
  "ثبت‌نام عمومی موقتاً برای تعمیرات متوقف شده است. لطفاً کمی بعد دوباره تلاش کنید.";

export interface SignupControls {
  /** The console switch. Only meaningful while `maintenanceMode` is false. */
  publicSignupEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
}

/** What an install with no stored row is *not* asserting. */
export const DEFAULT_SIGNUP_CONTROLS: SignupControls = {
  publicSignupEnabled: false,
  maintenanceMode: false,
  maintenanceMessage: null,
  updatedAt: null,
  updatedBy: null,
  updatedByName: null,
};

export type SignupGateReason =
  | "enabled"
  | "administratively_disabled"
  | "maintenance"
  | "environment_disabled";

/** Where the effective answer came from. */
export type SignupGateSource = "runtime" | "environment";

export interface SignupGate {
  enabled: boolean;
  reason: SignupGateReason;
  source: SignupGateSource;
}

/**
 * The public error code for a closed gate.
 *
 * Two codes, not one: an admin-disabled door and a maintenance pause need
 * different copy (and a maintenance pause has a "come back later" message),
 * while neither may say *why* beyond that.
 */
export function signupGateError(reason: SignupGateReason): "signup_disabled" | "signup_maintenance" {
  return reason === "maintenance" ? "signup_maintenance" : "signup_disabled";
}

/**
 * The one decision. Pure, so the precedence above is testable without a
 * database.
 *
 * `runtime` is a normalised stored control or `null` when no row is stored (or
 * the row could not be read/validated). `environmentValue` is the raw
 * `ALLOW_PUBLIC_SIGNUP`, and only the exact string `"true"` opens the gate —
 * the same rule the deployment has always used.
 */
export function resolveSignupGate(
  runtime: SignupControls | null,
  environmentValue: string | undefined,
): SignupGate {
  if (runtime) {
    if (runtime.maintenanceMode) {
      return { enabled: false, reason: "maintenance", source: "runtime" };
    }
    return runtime.publicSignupEnabled
      ? { enabled: true, reason: "enabled", source: "runtime" }
      : { enabled: false, reason: "administratively_disabled", source: "runtime" };
  }

  return environmentValue === "true"
    ? { enabled: true, reason: "enabled", source: "environment" }
    : { enabled: false, reason: "environment_disabled", source: "environment" };
}

/** Normalise an optional Persian maintenance message. Empty means "none". */
export function normalizeMaintenanceMessage(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "invalid";
  const message = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return null;
  if (message.length > SIGNUP_MAINTENANCE_MESSAGE_MAX) return "invalid";
  return message;
}

interface SignupSettingsRow {
  [key: string]: unknown;
  public_signup_enabled: boolean;
  maintenance_mode: boolean;
  maintenance_message: string | null;
  updated_at: Date;
  updated_by: string | null;
  updated_by_name: string | null;
}

/** Map one stored row, refusing a shape the caller must not act on. */
export function signupControlsFromRow(row: unknown): SignupControls | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as Record<string, unknown>;
  if (typeof raw.public_signup_enabled !== "boolean") return null;
  if (typeof raw.maintenance_mode !== "boolean") return null;
  const message = raw.maintenance_message;
  if (message !== null && message !== undefined && typeof message !== "string") return null;
  const updatedAt = raw.updated_at;
  return {
    publicSignupEnabled: raw.public_signup_enabled,
    maintenanceMode: raw.maintenance_mode,
    maintenanceMessage: typeof message === "string" ? message : null,
    updatedAt:
      updatedAt instanceof Date
        ? updatedAt.toISOString()
        : typeof updatedAt === "string"
          ? updatedAt
          : null,
    updatedBy: typeof raw.updated_by === "string" ? raw.updated_by : null,
    updatedByName: typeof raw.updated_by_name === "string" ? raw.updated_by_name : null,
  };
}

export interface ReadSignupControlsResult {
  controls: SignupControls | null;
  /** False when the table could not be read at all (older schema, DB error). */
  readable: boolean;
}

/**
 * Read the stored control.
 *
 * Never throws: a signup door must answer "the deployment gate decides" rather
 * than 500 when the control table is unavailable. The log line carries the
 * database's message only — there is no personal data in this read.
 */
export async function readSignupControls(): Promise<ReadSignupControlsResult> {
  try {
    const { rows } = await withoutTenantScope("platform", () =>
      query<SignupSettingsRow>(
        `SELECT s.public_signup_enabled, s.maintenance_mode, s.maintenance_message,
                s.updated_at, s.updated_by, pa.full_name AS updated_by_name
           FROM platform_signup_settings s
           LEFT JOIN platform_admins pa ON pa.id = s.updated_by
          WHERE s.id = 1`,
      ),
    );
    const controls = rows[0] ? signupControlsFromRow(rows[0]) : null;
    if (rows[0] && !controls) {
      console.error("[signup-controls] stored control has an invalid shape; using the environment gate");
      return { controls: null, readable: false };
    }
    return { controls, readable: true };
  } catch (error) {
    console.error("[signup-controls] could not read the stored control; using the environment gate", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return { controls: null, readable: false };
  }
}

/** The effective gate for the current deployment. */
export async function loadSignupGate(): Promise<SignupGate & ReadSignupControlsResult> {
  const read = await readSignupControls();
  return { ...resolveSignupGate(read.controls, process.env.ALLOW_PUBLIC_SIGNUP), ...read };
}

export interface SaveSignupControlsInput {
  publicSignupEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
}

/**
 * Persist the control. The caller already holds `signup.manage` and writes the
 * audit row, so this module stays the one place the setting is stored.
 */
export async function saveSignupControls(
  input: SaveSignupControlsInput,
  adminId: string,
): Promise<SignupControls> {
  const message = normalizeMaintenanceMessage(input.maintenanceMessage);
  await withoutTenantScope("platform", () =>
    query(
      `INSERT INTO platform_signup_settings
         (id, public_signup_enabled, maintenance_mode, maintenance_message, updated_at, updated_by)
       VALUES (1, $1, $2, $3, now(), $4)
       ON CONFLICT (id) DO UPDATE
          SET public_signup_enabled = EXCLUDED.public_signup_enabled,
              maintenance_mode = EXCLUDED.maintenance_mode,
              maintenance_message = EXCLUDED.maintenance_message,
              updated_at = now(),
              updated_by = EXCLUDED.updated_by`,
      [
        input.publicSignupEnabled,
        input.maintenanceMode,
        message === "invalid" ? null : message,
        adminId,
      ],
    ),
  );
  const { controls } = await readSignupControls();
  if (!controls) throw new Error("signup controls vanished after save");
  return controls;
}

// ---------------------------------------------------------------------------
// Inspection budget
// ---------------------------------------------------------------------------
//
// Searching and revealing an account is an operator tool, not a browsing
// surface: both endpoints are per-admin rate limited through the existing
// `auth_login_attempts` ledger (realm `platform_admin`, a key of its own), so a
// hijacked console session cannot mine the identity table, and no new table or
// limiter mechanism is introduced.

export const SIGNUP_INSPECTION_MAX_PER_MINUTE = 20;

export type InspectionLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** Pure: is one more lookup allowed, and if not, when? */
export function inspectionLimitDecision(
  timestamps: ReadonlyArray<Date | string | number>,
  now: Date = new Date(),
): InspectionLimitDecision {
  const reference = now.getTime();
  const inside = timestamps
    .map((value) => new Date(value).getTime())
    .filter((ms) => Number.isFinite(ms) && reference - ms < 60_000)
    .sort((a, b) => b - a);
  if (inside.length < SIGNUP_INSPECTION_MAX_PER_MINUTE) return { allowed: true };
  const oldest = inside[inside.length - 1];
  return { allowed: false, retryAfterMs: Math.max(0, 60_000 - (reference - oldest)) };
}

function inspectionKey(adminId: string): string {
  return `signup-inspection:${adminId}`;
}

/**
 * Count this admin's lookups in the last minute and record this one.
 *
 * The record is written only when the lookup is allowed, so a blocked caller
 * does not extend their own window by retrying.
 */
export async function reserveSignupInspection(adminId: string): Promise<InspectionLimitDecision> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ created_at: Date }>(
      `SELECT created_at FROM auth_login_attempts
        WHERE realm = 'platform_admin' AND identity_key = $1
        ORDER BY created_at DESC LIMIT 40`,
      [inspectionKey(adminId)],
    );
    const decision = inspectionLimitDecision(rows.map((row) => row.created_at));
    if (!decision.allowed) return decision;
    await query(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
       VALUES ('platform_admin', $1, 'success')`,
      [inspectionKey(adminId)],
    );
    return decision;
  });
}
