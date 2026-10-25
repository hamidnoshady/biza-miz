import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMasterKeyCache, setMasterKeyOverride } from "./master-key";
import {
  hasPlaintextServerSyncToken,
  openServerSyncConfig,
  sealServerSyncConfig,
} from "./server-sync-secret";

const KEY = randomBytes(32);
const CONFIG = {
  remoteUrl: "https://cloud.example.com",
  token: "sync-token-that-must-not-be-stored",
  enabled: true,
  siteDeviceId: "device-1",
};

beforeEach(() => {
  setMasterKeyOverride(KEY);
});
afterEach(() => {
  setMasterKeyOverride(null);
  resetMasterKeyCache();
});

describe("server sync token protection", () => {
  it("stores authenticated ciphertext and returns the original runtime config", () => {
    const stored = sealServerSyncConfig(CONFIG) as Record<string, unknown>;
    expect(stored.token).toBeUndefined();
    expect(String(stored.tokenCiphertext)).toMatch(/^mk1\.v1\./);
    expect(JSON.stringify(stored)).not.toContain(CONFIG.token);
    expect(openServerSyncConfig(stored)).toEqual(CONFIG);
  });

  it("keeps legacy plaintext readable for the atomic migration", () => {
    expect(hasPlaintextServerSyncToken(CONFIG)).toBe(true);
    expect(openServerSyncConfig(CONFIG)).toEqual(CONFIG);
    expect(hasPlaintextServerSyncToken(sealServerSyncConfig(CONFIG))).toBe(false);
  });

  it("fails closed on a wrong key or tampering", () => {
    const stored = sealServerSyncConfig(CONFIG) as Record<string, unknown>;
    setMasterKeyOverride(randomBytes(32));
    expect(() => openServerSyncConfig(stored)).toThrow();
    setMasterKeyOverride(KEY);
    const parts = String(stored.tokenCiphertext).split(".");
    const tag = Buffer.from(parts[3], "base64url");
    tag[0] ^= 1;
    parts[3] = tag.toString("base64url");
    expect(() => openServerSyncConfig({ ...stored, tokenCiphertext: parts.join(".") })).toThrow();
  });

  it("removes an old ciphertext when the Owner detaches and clears the token", () => {
    const sealed = sealServerSyncConfig(CONFIG);
    const detached = sealServerSyncConfig({ ...CONFIG, token: "", enabled: false }) as Record<string, unknown>;
    expect(detached).toMatchObject({ token: "", enabled: false });
    expect(detached.tokenCiphertext).toBeUndefined();
    expect(openServerSyncConfig(sealed)).toEqual(CONFIG);
  });

  it("keeps integration-key ciphertext readable after a master key is later configured", () => {
    setMasterKeyOverride(null);
    delete process.env.POS_MASTER_KEY;
    delete process.env.POS_MASTER_PASSPHRASE;
    resetMasterKeyCache();
    const stored = sealServerSyncConfig(CONFIG) as Record<string, unknown>;
    expect(String(stored.tokenCiphertext)).toMatch(/^ik1\./);
    setMasterKeyOverride(KEY);
    expect(openServerSyncConfig(stored)).toEqual(CONFIG);
  });
});
