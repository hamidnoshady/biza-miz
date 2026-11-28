/**
 * #1585 — renewal risk, as one pure function.
 *
 * A remembered-login credential proves possession of *that* credential. It says
 * nothing about who is holding the browser today, so every renewal is a decision
 * rather than a formality. This module makes that decision testable without a
 * database, a clock or a request:
 *
 *  - **low** — a valid, unrevoked, unexpired credential with credible identity,
 *    membership and token-version state. Normal restarts, ordinary IP/network
 *    drift (including a VPN), and minor browser updates are all low: they are
 *    the everyday case, and logging people out for them is how a "remember me"
 *    feature becomes a support queue.
 *  - **moderate** — the device context really changed (browser family or OS
 *    family), on an otherwise valid credential. The route may answer with a
 *    purpose-bound password step-up — but only where the existing MFA policy
 *    allows password-only verification; this module never decides that.
 *  - **high** — anything that breaks the premise: a revoked, expired or
 *    replayed credential, a dead identity, a lost membership, a stale token
 *    version, an active lockout, or both axes of the device context changing at
 *    once. Never renew; revoke or send the person to a full sign-in.
 *
 * ## What is deliberately not collected
 *
 * No IP address, no canvas/font/hardware probe, no user-agent string, no
 * persistent device identifier. The primary proof of possession is the opaque
 * credential itself; the fields below are coarse, browser-derived hints whose
 * only power is to *raise* friction. A fingerprint that can be wrong in the
 * permissive direction is worse than none.
 */

/** Coarse browser family. Anything unrecognised is `unknown`, never a guess. */
export type BrowserFamily =
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "opera"
  | "samsung"
  | "unknown";

/** Coarse operating-system family. */
export type OsFamily =
  | "windows"
  | "macos"
  | "linux"
  | "android"
  | "ios"
  | "unknown";

/**
 * The minimal, privacy-safe context stored with a remembered login.
 *
 * `regionHint` is a coarse top-level region (a country code from a trusted CDN
 * header), never an address and never a coordinate. Null means "no signal",
 * which is treated as unchanged rather than as a mismatch — a deployment behind
 * a proxy that does not set the header must not force step-ups on everyone.
 */
export interface DeviceContext {
  browserFamily: BrowserFamily;
  osFamily: OsFamily;
  regionHint: string | null;
}

export const EMPTY_DEVICE_CONTEXT: DeviceContext = {
  browserFamily: "unknown",
  osFamily: "unknown",
  regionHint: null,
};

/**
 * Browser and OS family from a user-agent string.
 *
 * Order matters: every Chromium browser also says `Chrome/`, and every WebKit
 * browser says `Safari/`, so the more specific token has to win. Unknown values
 * stay `unknown` so a malformed header cannot be mistaken for a change.
 */
export function deviceContextFromUserAgent(
  userAgent: string | null | undefined,
  regionHint: string | null = null,
): DeviceContext {
  const ua = typeof userAgent === "string" ? userAgent : "";

  let browserFamily: BrowserFamily = "unknown";
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) browserFamily = "edge";
  else if (/OPR\/|Opera\//i.test(ua)) browserFamily = "opera";
  else if (/SamsungBrowser\//i.test(ua)) browserFamily = "samsung";
  else if (/Firefox\/|FxiOS\//i.test(ua)) browserFamily = "firefox";
  else if (/Chrome\/|CriOS\//i.test(ua)) browserFamily = "chrome";
  else if (/Safari\//i.test(ua)) browserFamily = "safari";

  let osFamily: OsFamily = "unknown";
  if (/Android/i.test(ua)) osFamily = "android";
  else if (/iPhone|iPad|iPod/i.test(ua)) osFamily = "ios";
  else if (/Windows/i.test(ua)) osFamily = "windows";
  else if (/Macintosh|Mac OS X/i.test(ua)) osFamily = "macos";
  else if (/Linux|X11/i.test(ua)) osFamily = "linux";

  const region = typeof regionHint === "string" ? regionHint.trim().toUpperCase() : "";
  return {
    browserFamily,
    osFamily,
    regionHint: /^[A-Z]{2}$/.test(region) ? region : null,
  };
}

export type RenewalRiskLevel = "low" | "moderate" | "high";

/**
 * Why a decision came out the way it did.
 *
 * A closed vocabulary of reason codes rather than free text: these end up in
 * audit payloads and metrics, and a code cannot accidentally carry a value
 * somebody typed.
 */
export type RenewalRiskReason =
  | "credential_unknown"
  | "credential_replayed"
  | "family_revoked"
  | "family_expired"
  | "identity_inactive"
  | "membership_inactive"
  | "token_version_stale"
  | "account_locked"
  | "browser_family_changed"
  | "os_family_changed"
  | "region_changed"
  | "context_combination";

export interface RenewalRiskInput {
  /** The presented secret resolves to a credential row. */
  credentialValid: boolean;
  /** …whose `superseded_at` is already set (a replay, outside any grace). */
  replayed?: boolean;
  familyRevoked?: boolean;
  /** Either deadline has passed. */
  familyExpired?: boolean;
  identityActive?: boolean;
  membershipActive?: boolean;
  tokenVersionMatches?: boolean;
  accountLocked?: boolean;
  /** Context stored when the family was issued or last rotated. */
  stored: DeviceContext;
  /** Context of this request. */
  current: DeviceContext;
}

export interface RenewalRiskDecision {
  level: RenewalRiskLevel;
  reasons: RenewalRiskReason[];
}

/**
 * Classify one renewal.
 *
 * Fatal conditions are checked first and short-circuit: a revoked credential
 * with an unchanged user-agent is still revoked, and reporting it as "moderate"
 * would let a caller talk itself into a step-up instead of a refusal.
 */
export function classifyRenewalRisk(input: RenewalRiskInput): RenewalRiskDecision {
  const fatal: RenewalRiskReason[] = [];
  if (!input.credentialValid) fatal.push("credential_unknown");
  if (input.replayed) fatal.push("credential_replayed");
  if (input.familyRevoked) fatal.push("family_revoked");
  if (input.familyExpired) fatal.push("family_expired");
  if (input.identityActive === false) fatal.push("identity_inactive");
  if (input.membershipActive === false) fatal.push("membership_inactive");
  if (input.tokenVersionMatches === false) fatal.push("token_version_stale");
  if (input.accountLocked === true) fatal.push("account_locked");
  if (fatal.length > 0) return { level: "high", reasons: fatal };

  const browserChanged =
    input.current.browserFamily !== "unknown" &&
    input.stored.browserFamily !== "unknown" &&
    input.current.browserFamily !== input.stored.browserFamily;
  const osChanged =
    input.current.osFamily !== "unknown" &&
    input.stored.osFamily !== "unknown" &&
    input.current.osFamily !== input.stored.osFamily;
  const regionChanged =
    input.current.regionHint !== null &&
    input.stored.regionHint !== null &&
    input.current.regionHint !== input.stored.regionHint;

  /*
   * Two axes at once is the shape of a credential lifted onto a different
   * machine, and it is refused outright. One axis is a plausible upgrade path
   * (a person who installed a new browser, or switched from a laptop to a
   * desktop) and gets the moderate treatment.
   *
   * A region change on its own is *low*: travelling, a VPN, a mobile network or
   * a café's Wi-Fi all move the address without moving the person. Treating it
   * as suspicious is exactly the behaviour the issue forbids.
   */
  if ((browserChanged && osChanged) || (osChanged && regionChanged)) {
    return {
      level: "high",
      reasons: [
        ...(browserChanged ? (["browser_family_changed"] as const) : []),
        ...(osChanged ? (["os_family_changed"] as const) : []),
        ...(regionChanged ? (["region_changed"] as const) : []),
        "context_combination",
      ],
    };
  }
  if (browserChanged || osChanged) {
    return {
      level: "moderate",
      reasons: [
        ...(browserChanged ? (["browser_family_changed"] as const) : []),
        ...(osChanged ? (["os_family_changed"] as const) : []),
      ],
    };
  }

  return { level: "low", reasons: regionChanged ? ["region_changed"] : [] };
}
