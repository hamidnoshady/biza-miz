/**
 * Issue #854 (P1.3 / P1.4 / P1.5 / P2.27) — one typed session contract.
 *
 * The Profile session card and `/api/sessions/self` disagreed about almost
 * everything:
 *
 *  - the UI expected `startedAt` / `locationName` / a non-null `lastSeenAt`;
 *    the API returned `issuedAt`, no branch name, and a nullable `lastSeenAt`,
 *    so a session that had never been touched rendered an invalid date
 *    (#854 P1.5);
 *  - the UI revoked with `DELETE` and the route implemented `POST` only, which
 *    made every revoke button fail with a 405 the card reported as "could not
 *    end the session" (#854 P1.3);
 *  - and the list showed the *current business's* sessions while
 *    `revoke_others` silently revoked the **global identity's** sessions —
 *    every business plus impersonation grants — so a member could end sessions
 *    they were never shown (#854 P1.4).
 *
 * The contract below fixes the third by naming the scope explicitly. The
 * model is Option B from the issue:
 *
 *  - **business scope** — what the list shows and what `revoke_one` /
 *    `revoke_others` affect. Nothing outside it is ever touched by them.
 *  - **global scope** — a separate, explicitly-labelled "sign out everywhere"
 *    that revokes across every business the identity belongs to, ends support
 *    impersonation, and bumps `token_version`. It is its own action with its
 *    own confirmation, and its response says so.
 *
 * Nothing here imports the database, so the client component and the route
 * share the shape rather than each describing it.
 */

/** What a revocation touched. */
export type SessionScope = "business" | "global";

/**
 * Login methods a session can have been minted by, for the device card. Kept
 * narrow on purpose: this is a label, not an authorization input.
 */
export const SESSION_LOGIN_METHODS = [
  "password",
  "phone_otp",
  "pin",
  "webauthn",
  "invitation",
  "impersonation",
] as const;

export type SessionLoginMethod = (typeof SESSION_LOGIN_METHODS)[number];

export function isSessionLoginMethod(value: unknown): value is SessionLoginMethod {
  return (
    typeof value === "string" &&
    (SESSION_LOGIN_METHODS as readonly string[]).includes(value)
  );
}

/** One row of the session list. Every timestamp is ISO-8601 UTC. */
export interface SelfSessionView {
  id: string;
  /** Business this session belongs to — present because the contract is reusable if a global list is ever shown. */
  businessId: string;
  businessName: string | null;
  locationId: string | null;
  locationName: string | null;
  /** A parsed "Chrome on Windows" style label, never the raw user-agent. */
  deviceLabel: string | null;
  /** Raw user-agent, kept for the expandable detail. */
  userAgent: string | null;
  loginMethod: SessionLoginMethod | null;
  issuedAt: string;
  /**
   * Null when the session has never been seen since it was issued. The UI must
   * fall back to `issuedAt` rather than rendering an empty or invalid date.
   */
  lastSeenAt: string | null;
  expiresAt: string;
  isCurrent: boolean;
}

export interface SelfSessionsResponse {
  /** Which set these rows are, so the card can say what revoking will reach. */
  scope: SessionScope;
  /** The revocable-without-recent-auth subset's size, so the UI can disable buttons. */
  revocableCount: number;
  currentSessionId: string | null;
  recentAuth: boolean;
  maxAgeSeconds: number;
  sessions: SelfSessionView[];
}

export interface SessionRevokeResponse {
  ok: true;
  action: SessionRevokeAction;
  /** The scope that was *actually* affected. */
  scope: SessionScope;
  revokedCount: number;
  /** True when the caller's own session was among the revoked ones. */
  signedOut: boolean;
  /** True when a new cookie was issued to keep the caller signed in. */
  sessionRefreshed?: boolean;
}

export const SESSION_REVOKE_ACTIONS = [
  /** End one named session in this business. */
  "revoke_one",
  /** End every other session in this business. Requires recent auth. */
  "revoke_others",
  /** Sign out everywhere: every business, plus impersonation. Requires recent auth. */
  "revoke_all",
] as const;

export type SessionRevokeAction = (typeof SESSION_REVOKE_ACTIONS)[number];

export function isSessionRevokeAction(value: unknown): value is SessionRevokeAction {
  return typeof value === "string" && (SESSION_REVOKE_ACTIONS as readonly string[]).includes(value);
}

/** Persian description of what an action will reach — shown in the confirmation. */
export function sessionRevokeDescription(action: SessionRevokeAction): string {
  switch (action) {
    case "revoke_one":
      return "این نشست در همین کسب‌وکار بسته می‌شود. سایر دستگاه‌ها دست‌نخورده می‌مانند.";
    case "revoke_others":
      return "همهٔ نشست‌های دیگر شما در همین کسب‌وکار بسته می‌شوند. نشست‌های شما در کسب‌وکارهای دیگر بسته نمی‌شوند.";
    case "revoke_all":
      return "همهٔ نشست‌های شما در همهٔ کسب‌وکارها بسته می‌شود و دسترسی‌های پشتیبانی نیز پایان می‌یابد. برای ادامه باید دوباره وارد شوید.";
  }
}

/**
 * Persian label for a session's login method (P2.27: "which door was this?").
 *
 * A label, never an authorization input — the route decides what a session may
 * do, this only says how it was opened.
 */
export function sessionLoginMethodLabel(method: SessionLoginMethod | null): string | null {
  switch (method) {
    case "password":
      return "ورود با رمز عبور";
    case "phone_otp":
      return "ورود با کد پیامکی";
    case "pin":
      return "ورود با رمز عددی";
    case "webauthn":
      return "ورود با اثر انگشت / بیومتریک";
    case "invitation":
      return "ورود از طریق دعوت‌نامه";
    case "impersonation":
      return "پشتیبانی فنی";
    default:
      return null;
  }
}

/**
 * Fallback the UI uses for a row with no activity timestamp.
 *
 * Named rather than inlined because it is the actual fix for P1.5: an unparsed
 * `lastSeenAt` used to reach `formatJalali` and render an empty cell for a
 * session that was merely brand new.
 */
export function sessionActivityIso(session: SelfSessionView): string {
  return session.lastSeenAt ?? session.issuedAt;
}

/**
 * Turn a raw user-agent into a label a person recognises (P2.27).
 *
 * Deliberately coarse: a device card needs "کروم روی ویندوز", not a
 * fingerprint. Parsing is best-effort and falls back to the head of the string
 * rather than inventing a device.
 */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.trim();
  if (!ua) return null;

  const browser = ua.match(/(Edg|OPR|Chrome|Safari|Firefox)\/([\d.]+)/)?.[1];
  const browserName =
    browser === "Edg"
      ? "Edge"
      : browser === "OPR"
        ? "Opera"
        : (browser ?? null);

  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Macintosh|Mac OS X/i.test(ua)
      ? "macOS"
      : /Android/i.test(ua)
        ? "Android"
        : /iPhone|iPad|iPod/i.test(ua)
          ? "iOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : null;

  const electron = /Electron/i.test(ua);
  const parts = [electron ? "برنامهٔ دسکتاپ" : browserName, os].filter(Boolean);
  if (parts.length === 0) return ua.slice(0, 60);
  return parts.join(" · ");
}
