/**
 * Issue #1115 §A.3 — browser-based enrollment of an *unpaired* Windows Hybrid
 * install.
 *
 * The old Hybrid first run made the owner copy a 12-character pairing code out
 * of the Cloud panel and type it into the app. That works, but it is exactly
 * the manual Cloud configuration the epic removes: the owner is already signed
 * in in the browser, and the app is perfectly capable of being told "yes, this
 * device" there.
 *
 * The shape here is the standard one for authorizing a device that cannot yet
 * authenticate, adapted to the pairing machinery this repo already has:
 *
 *   1. The app mints a 32-byte **device secret**, keeps it, and registers only
 *      its SHA-256 with the Cloud, together with a short installation id.
 *   2. The Cloud answers a request id and an 8-character **user code** in the
 *      pairing alphabet. The app opens `/desktop-enroll/<id>` in the system
 *      browser.
 *   3. The signed-in owner sees the device and the code, picks the branch, and
 *      confirms. The Cloud mints an ordinary one-time **pairing code** and
 *      seals it against the request.
 *   4. The app polls with its device secret until it is handed that code, then
 *      redeems it through `/api/pairing/redeem` — the same two-phase snapshot
 *      path a typed code takes. Nothing about enrollment is a second identity
 *      system, and no code, token or snapshot is ever placed in a URL.
 *
 * The client-safe half (codes, poll cadence, the poll/approval state machine)
 * lives in `desktop-enroll-shared.ts`, because this module reaches
 * `node:crypto` and client components must not. Server code keeps importing
 * this file: everything shared is re-exported below.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PAIRING_CODE_ALPHABET } from "./code-alphabet";
import {
  ENROLLMENT_PATH,
  ENROLLMENT_USER_CODE_LENGTH,
  isEnrollmentRequestId,
} from "./desktop-enroll-shared";

export {
  canApprove,
  ENROLLMENT_PATH,
  ENROLLMENT_POLL_INTERVAL_MS,
  ENROLLMENT_TTL_SECONDS,
  ENROLLMENT_USER_CODE_LENGTH,
  formatUserCode,
  isEnrollmentRequestId,
  isInstallationId,
  isUserCodeAlphabet,
  normalizeUserCode,
  pollEnrollment,
} from "./desktop-enroll-shared";
export type {
  EnrollmentFacts,
  EnrollmentPoll,
  EnrollmentState,
} from "./desktop-enroll-shared";

const SECRET = /^[A-Za-z0-9_-]{40,128}$/;
const HASH = /^[0-9a-f]{64}$/;

/**
 * The secret half of the reservation. 32 bytes of CSPRNG output, base64url, so
 * it survives a JSON round trip untouched and cannot be guessed; the Cloud
 * only ever sees its hash.
 */
export function newDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function isDeviceSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET.test(value);
}

export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Constant-time comparison of the presented secret with the stored hash, so a
 * poll cannot be used as a hashing oracle for a guessed secret.
 */
export function deviceSecretMatches(secret: unknown, storedHash: string): boolean {
  if (!isDeviceSecret(secret) || !HASH.test(storedHash)) return false;
  const presented = Buffer.from(hashDeviceSecret(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/** The code the owner reads on screen; the pairing alphabet already excludes O/0 and I/1. */
export function generateUserCode(): string {
  let code = "";
  for (let i = 0; i < ENROLLMENT_USER_CODE_LENGTH; i += 1) {
    code += PAIRING_CODE_ALPHABET[randomBytes(4).readUInt32BE(0) % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * The Cloud page to open in the system browser.
 *
 * HTTPS only, and the path is exactly this request: the desktop verifies both
 * before opening anything, so a compromised or misconfigured Cloud cannot turn
 * enrollment into a link to somewhere else.
 */
export function enrollmentVerificationUrl(origin: string, requestId: string): string | null {
  if (!isEnrollmentRequestId(requestId)) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${ENROLLMENT_PATH}/${requestId}`;
}

/** The desktop's check on the URL the Cloud handed back, before it opens it. */
export function isVerificationUrlFor(
  verificationUrl: unknown,
  origin: string,
  requestId: string,
): boolean {
  if (typeof verificationUrl !== "string") return false;
  const expected = enrollmentVerificationUrl(origin, requestId);
  return expected !== null && verificationUrl === expected;
}

/** A per-request rate-limit key: one poll bucket per reservation, never per IP. */
export function enrollmentPollKey(requestId: string): string {
  return `desktop-enroll:poll:${requestId}`;
}
