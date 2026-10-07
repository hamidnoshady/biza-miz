import { describe, expect, it } from "vitest";
import { assertDecryptable, parseArgs } from "../../scripts/encrypt-ai-gateway-secrets";
import { encryptSecret } from "./integrations/secrets";

describe("AI gateway secret cutover helpers", () => {
  const key = Buffer.alloc(32, 0x37);

  it("parses the dry-run, entrypoint and ciphertext-only verification modes", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true, verifyOnly: false, keepPlaintext: false });
    expect(parseArgs(["--verify-only"])).toEqual({ dryRun: false, verifyOnly: true, keepPlaintext: false });
    expect(parseArgs(["--keep-plaintext"])).toEqual({ dryRun: false, verifyOnly: false, keepPlaintext: true });
    expect(parseArgs([])).toEqual({ dryRun: false, verifyOnly: false, keepPlaintext: false });
  });

  it("decrypt-verifies that the stored ciphertext matches the legacy plaintext", () => {
    const ciphertext = encryptSecret("sk-live-example", key);
    expect(assertDecryptable(ciphertext, "business-key", key, "sk-live-example")).toBe("sk-live-example");
    expect(() => assertDecryptable(ciphertext, "business-key", key, "sk-different-value"))
      .toThrow("ai_gateway_secret_ciphertext_invalid:business-key");
  });

  it("rejects ciphertext that cannot be decrypted with the deployment key", () => {
    const ciphertext = encryptSecret("sk-live-example", key);
    expect(() => assertDecryptable(ciphertext, "master-key", Buffer.alloc(32, 0x38)))
      .toThrow("ai_gateway_secret_ciphertext_invalid:master-key");
  });
});
