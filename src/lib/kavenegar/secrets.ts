/**
 * Issue #902 — child API-key encryption.
 *
 * A child key can send SMS as a tenant and therefore costs the platform money;
 * it is a secret in the same class as the master key already stored in
 * `platform_sms_config`. Two rules follow, and both are enforced here rather
 * than trusted to callers:
 *
 *   * **Encrypted, never plaintext.** The envelope is
 *     `POSKVN1 | IV(12) | GCM tag(16) | ciphertext`, AES-256-GCM under the
 *     platform realm secret. The magic is deliberate: a ciphertext piped into
 *     the wrong decryptor fails the magic check instead of authenticating
 *     against the wrong key and returning plausible nonsense (the same reason
 *     `field-crypto.ts` prefixes its envelope).
 *   * **Versioned.** `api_key_version` travels with the ciphertext, so a future
 *     re-key can re-encrypt rows in place and still read the old ones. This
 *     module refuses an unknown version instead of guessing.
 *
 * `hint` is the last four characters and nothing else; it answers "is this the
 * key the console shows" and cannot send.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("POSKVN1", "latin1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Bump only together with a re-encryption path for the previous value. */
export const CURRENT_CHILD_KEY_VERSION = 1;

export class ChildKeyDecryptError extends Error {
  constructor(readonly reason: "unknown_version" | "bad_magic" | "truncated" | "auth_failed") {
    super(`kavenegar_child_key_${reason}`);
    this.name = "ChildKeyDecryptError";
  }
}

export function encryptChildApiKey(plain: string, key: Uint8Array): Buffer {
  if (!plain) throw new Error("kavenegar_child_key_empty");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptChildApiKey(
  data: Buffer,
  key: Uint8Array,
  version: number = CURRENT_CHILD_KEY_VERSION,
): string {
  if (version !== CURRENT_CHILD_KEY_VERSION) throw new ChildKeyDecryptError("unknown_version");
  const minimum = MAGIC.length + IV_LENGTH + TAG_LENGTH + 1;
  if (data.length < MAGIC.length + IV_LENGTH + TAG_LENGTH) {
    throw new ChildKeyDecryptError("truncated");
  }
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new ChildKeyDecryptError("bad_magic");
  if (data.length < minimum) throw new ChildKeyDecryptError("truncated");

  let offset = MAGIC.length;
  const iv = data.subarray(offset, (offset += IV_LENGTH));
  const tag = data.subarray(offset, (offset += TAG_LENGTH));
  const ciphertext = data.subarray(offset);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // A wrong key and a corrupted row are the same event to a caller: this
    // credential cannot be used. It must never fall back to a provider key.
    throw new ChildKeyDecryptError("auth_failed");
  }
}

/**
 * Last four characters for the console. Short keys are refused outright — a
 * four-character key would be revealed in full by its own hint.
 */
export function childApiKeyHint(plain: string): string | null {
  if (plain.length < 12) return null;
  return `••••${plain.slice(-4)}`;
}
