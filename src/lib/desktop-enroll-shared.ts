/**
 * Issue #1115 §A.3 — the part of browser enrollment a `"use client"` component
 * may import.
 *
 * `desktop-enroll.ts` reaches `node:crypto` (device secrets, hashing,
 * comparison), which must never enter the browser bundle; the wizard and the
 * confirmation page still need the shared vocabulary — the poll cadence, the
 * TTL, and how a read-aloud user code is displayed and folded. Same split, and
 * same reason, as `ai-runtime-modes-shared.ts`.
 *
 * No node builtins, no database, no Next imports.
 */
import { PAIRING_CODE_ALPHABET, foldDigits } from "./code-alphabet";

/** Long enough to sign into the browser, short enough that a leaked row is useless. */
export const ENROLLMENT_TTL_SECONDS = 10 * 60;
/** The app's poll cadence while it waits for the owner. */
export const ENROLLMENT_POLL_INTERVAL_MS = 2_500;
/** Where the Cloud serves the confirmation page. */
export const ENROLLMENT_PATH = "/desktop-enroll";
export const ENROLLMENT_USER_CODE_LENGTH = 8;

export type EnrollmentState = "pending" | "approved" | "denied" | "expired";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = /^[A-Za-z0-9:_.-]{8,200}$/;

/** `ABCDEFGH` → `ABCD-EFGH`, which is how it is shown and how people read it back. */
export function formatUserCode(code: string): string {
  const clean = normalizeUserCode(code);
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

/**
 * Fold what a person types back onto what was issued: Persian/Arabic digits,
 * lower case, separators, and the O/0 / I/1 look-alikes the alphabet avoids.
 */
export function normalizeUserCode(raw: string): string {
  return foldDigits(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replaceAll("0", "O")
    .replaceAll("1", "I");
}

/** The alphabet the issue uses, so a client can validate a code without the server module. */
export function isUserCodeAlphabet(code: string): boolean {
  return (
    code.length === ENROLLMENT_USER_CODE_LENGTH &&
    [...code].every((character) => PAIRING_CODE_ALPHABET.includes(character))
  );
}

export function isEnrollmentRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isInstallationId(value: unknown): value is string {
  return typeof value === "string" && INSTALLATION_ID.test(value);
}

/** What a poll may answer. Only `approved` carries a credential. */
export type EnrollmentPoll =
  | { status: "pending"; expiresAt: string }
  | { status: "approved"; pairingCode: string; expiresAt: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "not_found" };

export interface EnrollmentFacts {
  state: Exclude<EnrollmentState, "expired">;
  expiresAt: Date;
  /** Whether the approval has finished minting and sealing its pairing code. */
  hasPairingCode: boolean;
}

/**
 * The one place a row's state becomes an answer. A row is expired the moment
 * its TTL passes, whatever column it still carries, so a process that dies
 * mid-cleanup cannot extend a reservation.
 *
 * An approved row whose code has not been sealed yet answers `pending`: the
 * approval is in flight, and answering anything else would either tell the app
 * it is done when it is not or expose a half-finished approval.
 */
export function pollEnrollment(
  facts: EnrollmentFacts | null,
  pairingCode: string | null,
  now: Date,
): EnrollmentPoll {
  if (!facts) return { status: "not_found" };
  if (facts.state === "denied") return { status: "denied" };
  if (facts.expiresAt.getTime() <= now.getTime()) return { status: "expired" };
  if (facts.state === "approved" && facts.hasPairingCode && pairingCode) {
    return { status: "approved", pairingCode, expiresAt: facts.expiresAt.toISOString() };
  }
  return { status: "pending", expiresAt: facts.expiresAt.toISOString() };
}

/** Whether an approval claim may still be taken for this row. */
export function canApprove(
  facts: {
    state: EnrollmentState;
    expiresAt: Date;
    hasPairingCode: boolean;
  } | null,
  now: Date,
): boolean {
  if (!facts) return false;
  if (facts.expiresAt.getTime() <= now.getTime()) return false;
  // `approved` without a code is the interrupted claim; a retry must be able to
  // finish it rather than strand the request.
  if (facts.state === "pending") return true;
  return facts.state === "approved" && !facts.hasPairingCode;
}
