/**
 * Issue #908 — the two cryptographic facts a signing envelope needs, in one
 * place so neither is re-invented at a call site:
 *
 *  1. **A content hash** for every frozen document version, so a signature can
 *     be tied to exactly the text it was drawn on. It is a SHA-256 over a
 *     *canonical* JSON encoding (keys sorted, `undefined` dropped), because
 *     `JSON.stringify` preserves insertion order and two equal documents built
 *     by two code paths would otherwise hash differently — which would make
 *     every stored signature look like a tampered one.
 *
 *  2. **An invitation token and its hash at rest.** The token is 256 bits of
 *     randomness, base64url, printed once into the SMS (or handed to the sender
 *     to pass on manually) and never stored. The database holds an HMAC-SHA-256
 *     of it under the deployment's realm secret — the same secret the OTP
 *     challenges are hashed with — so a database dump cannot be replayed as a
 *     signing session, and a stolen hash cannot be brute-forced back to a token
 *     without the secret.
 *
 * Server-only (`node:crypto`); nothing here may be imported by a component.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getRealmSecret } from "../jwt-secret";

/** Stable JSON: object keys sorted recursively, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The hash stored on a frozen version and on every signature against it. */
export function contractContentHash(frozen: unknown): string {
  return sha256Hex(canonicalJson(frozen));
}

/** 32 random bytes, url-safe. The only form of the token that is ever printable. */
export function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Shape check before a hash is computed: a token that is not 43 chars is junk. */
export function looksLikeInvitationToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function hashInvitationToken(token: string): Promise<string> {
  const secret = await getRealmSecret("platform");
  return createHmac("sha256", secret).update(token, "utf8").digest("hex");
}

/** Constant-time comparison for two hex digests of the same length. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
