/**
 * Phase 23 (issue #118) — at-rest encryption for integration credentials.
 *
 * A WooCommerce connection's consumer key/secret and webhook secret have to be
 * sent back to the store on every request, so they can't be hashed the way an
 * API key is — they need reversible encryption. This module is the framework-
 * free, pure half (unit-tested in secrets.test.ts); the DB-touching service
 * resolves the key from the environment.
 *
 * Format of a ciphertext: `v1.<iv b64url>.<ciphertext b64url>.<tag b64url>`.
 * GCM auth means any tampering or wrong key fails decryption rather than
 * returning garbage.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { CredentialState } from "../ai-gateway";

const VERSION = "v1";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** 32-byte key from any secret: SHA-256, so the env value can be a passphrase, not just hex. */
export function deriveEncryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * The deployment key credentials are encrypted under. An explicit
 * `INTEGRATIONS_ENCRYPTION_KEY` (64 hex chars) wins; otherwise `JWT_SECRET`
 * is used so no new secret has to be provisioned. Rotating either orphans
 * existing ciphertexts — see the phase doc.
 */
export function resolveEncryptionKey(env: Record<string, string | undefined>): Buffer {
  const explicit = env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) {
      throw new Error("INTEGRATIONS_ENCRYPTION_KEY must be 64 hex characters");
    }
    return Buffer.from(explicit, "hex");
  }
  const fallback = env.JWT_SECRET?.trim();
  if (!fallback) {
    throw new Error("neither INTEGRATIONS_ENCRYPTION_KEY nor JWT_SECRET is set");
  }
  return deriveEncryptionKey(fallback);
}

export function encryptSecret(plain: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Throws on a malformed ciphertext, wrong key, or any tampering. */
export function decryptSecret(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("malformed ciphertext");
  const [, ivText, dataText, tagText] = parts;
  const iv = Buffer.from(ivText, "base64url");
  const data = Buffer.from(dataText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("decryption failed — wrong key or corrupted ciphertext");
  }
}

/**
 * The state of a stored credential, and its value when it can be read.
 *
 * `undecryptable` is the state that must never be flattened into "absent":
 * the credential is still stored, the provider may still honour it, and the
 * row that holds it is the only thing that remembers it.
 */
export interface StoredSecret {
  /** The decrypted value, or "" when the secret is absent or unreadable. */
  value: string;
  state: CredentialState;
}

/**
 * Read a stored ciphertext and say whether it is missing, usable, or merely
 * unreadable.
 *
 * The log line names no secret material — neither the ciphertext nor the
 * plaintext — because this runs inside request paths whose output may be
 * captured by a log shipper.
 */
export function readStoredSecret(ciphertext: string | null | undefined): StoredSecret {
  const text = typeof ciphertext === "string" ? ciphertext.trim() : "";
  if (!text) return { value: "", state: "absent" };
  try {
    return { value: decryptSecret(text, resolveEncryptionKey(process.env)), state: "present" };
  } catch {
    console.error(
      "stored secret could not be decrypted with this deployment's key; the credential is kept, not discarded",
    );
    return { value: "", state: "undecryptable" };
  }
}
