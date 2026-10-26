/**
 * Issue #902 — child-key encryption. The test proves the envelope refuses a
 * wrong key/version rather than silently returning garbage, because a "decrypt"
 * that succeeds against the wrong secret is worse than an error.
 */
import { describe, expect, it } from "vitest";
import {
  CURRENT_CHILD_KEY_VERSION,
  ChildKeyDecryptError,
  childApiKeyHint,
  decryptChildApiKey,
  encryptChildApiKey,
} from "./secrets";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const CHILD_KEY = "SSDG65644KF64HFFD87584KFYT985987545";

describe("child API key encryption", () => {
  it("round-trips a key with the platform realm secret", () => {
    const encrypted = encryptChildApiKey(CHILD_KEY, KEY);
    expect(encrypted.subarray(0, 7).toString("latin1")).toBe("POSKVN1");
    expect(encrypted.includes(Buffer.from(CHILD_KEY))).toBe(false);
    expect(decryptChildApiKey(encrypted, KEY, CURRENT_CHILD_KEY_VERSION)).toBe(CHILD_KEY);
  });

  it("refuses a ciphertext encrypted with a different key", () => {
    const encrypted = encryptChildApiKey(CHILD_KEY, KEY);
    expect(() => decryptChildApiKey(encrypted, OTHER_KEY)).toThrow(ChildKeyDecryptError);
  });

  it("refuses a value without the magic (wrong column, wrong decryptor)", () => {
    const notOurs = Buffer.from("plaintext-value-that-is-long-enough");
    expect(() => decryptChildApiKey(notOurs, KEY)).toThrowError(/bad_magic|truncated/);
  });

  it("refuses an unknown key version instead of guessing", () => {
    const encrypted = encryptChildApiKey(CHILD_KEY, KEY);
    expect(() => decryptChildApiKey(encrypted, KEY, 99)).toThrowError(/unknown_version/);
  });

  it("never emits a hint that reveals a short key", () => {
    expect(childApiKeyHint("short")).toBeNull();
    expect(childApiKeyHint(CHILD_KEY)).toBe("••••7545");
  });

  it("produces different ciphertexts for the same key (fresh IV each time)", () => {
    expect(encryptChildApiKey(CHILD_KEY, KEY).equals(encryptChildApiKey(CHILD_KEY, KEY))).toBe(false);
  });
});
