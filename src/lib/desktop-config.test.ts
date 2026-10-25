import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { loadOrCreateConfig, saveConfig } = require("../../electron/backend-manager.js") as {
  loadOrCreateConfig: (
    userData: string,
    options: { safeStorage: SafeStorage },
  ) => Promise<{ config: Record<string, unknown>; configPath: string }>;
  saveConfig: (configPath: string, config: Record<string, unknown>, safeStorage: SafeStorage) => void;
};

interface SafeStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

function xor(value: Buffer): Buffer {
  return Buffer.from(value.map((byte, index) => byte ^ (0x5a ^ (index % 17))));
}
const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => xor(Buffer.from(value, "utf8")),
  decryptString: (value) => xor(value).toString("utf8"),
};

const dirs: string[] = [];
function userData(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "desktop-config-"));
  dirs.push(root);
  return root;
}
function paths(root: string) {
  return {
    config: path.join(root, "Configuration", "config.json"),
    backup: path.join(root, "Configuration", "config.backup.json"),
    pgdata: path.join(root, "Data", "pgdata"),
  };
}
function completeConfig() {
  return {
    pgPassword: "known-postgres-secret",
    jwtSecret: "known-jwt-secret",
    masterKey: "known-master-key",
    instanceId: "instance-1",
    pgPort: 5544,
    appPort: 3000,
    gatewayPort: 8443,
    gateway: { enabled: false, selectedAddress: null },
  };
}
function decrypted(file: string) {
  const envelope = JSON.parse(readFileSync(file, "utf8"));
  return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64")));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Desktop protected configuration", () => {
  it("creates a fresh install without plaintext secrets in either copy", async () => {
    const root = userData();
    const { config } = await loadOrCreateConfig(root, { safeStorage });
    const p = paths(root);
    for (const file of [p.config, p.backup]) {
      const raw = readFileSync(file, "utf8");
      expect(JSON.parse(raw).encryption).toBe("electron-safeStorage");
      expect(raw).not.toContain(String(config.pgPassword));
      expect(raw).not.toContain(String(config.jwtSecret));
      expect(raw).not.toContain(String(config.masterKey));
    }
  });

  it("migrates legacy plaintext without making a plaintext rotated copy", async () => {
    const root = userData();
    const p = paths(root);
    mkdirSync(path.dirname(p.config), { recursive: true });
    writeFileSync(p.config, JSON.stringify(completeConfig()));
    const { config } = await loadOrCreateConfig(root, { safeStorage });
    expect(config).toMatchObject(completeConfig());
    for (const file of [p.config, p.backup]) {
      const raw = readFileSync(file, "utf8");
      expect(raw).not.toContain("known-postgres-secret");
      expect(raw).not.toContain("known-jwt-secret");
      expect(raw).not.toContain("known-master-key");
    }
  });

  it("rotates the previous readable configuration on update", () => {
    const root = userData();
    const p = paths(root);
    mkdirSync(path.dirname(p.config), { recursive: true });
    saveConfig(p.config, completeConfig(), safeStorage);
    saveConfig(p.config, { ...completeConfig(), appPort: 3001 }, safeStorage);
    expect(decrypted(p.config).appPort).toBe(3001);
    expect(decrypted(p.backup).appPort).toBe(3000);
    expect(decrypted(p.backup).masterKey).toBe("known-master-key");
  });

  it("recovers from the rotated copy without overwriting it with a corrupt primary", async () => {
    const root = userData();
    const p = paths(root);
    mkdirSync(path.dirname(p.config), { recursive: true });
    saveConfig(p.config, completeConfig(), safeStorage);
    const goodBackup = readFileSync(p.backup, "utf8");
    writeFileSync(p.config, "{broken");
    const { config } = await loadOrCreateConfig(root, { safeStorage });
    expect(config).toMatchObject(completeConfig());
    expect(readFileSync(p.backup, "utf8")).toBe(goodBackup);
    expect(decrypted(p.config).pgPassword).toBe("known-postgres-secret");
  });

  it("fails closed when config is absent and any pgdata directory exists", async () => {
    const root = userData();
    const p = paths(root);
    mkdirSync(p.pgdata, { recursive: true });
    await expect(loadOrCreateConfig(root, { safeStorage })).rejects.toMatchObject({ stage: "configuration" });
    expect(existsSync(p.config)).toBe(false);
    expect(existsSync(p.backup)).toBe(false);
  });

  it("never fills missing secrets when pgdata exists", async () => {
    const root = userData();
    const p = paths(root);
    mkdirSync(path.dirname(p.config), { recursive: true });
    mkdirSync(p.pgdata, { recursive: true });
    const partial = { ...completeConfig(), masterKey: undefined };
    writeFileSync(p.config, JSON.stringify(partial));
    await expect(loadOrCreateConfig(root, { safeStorage })).rejects.toMatchObject({ stage: "configuration" });
    expect(JSON.parse(readFileSync(p.config, "utf8")).masterKey).toBeUndefined();
    expect(JSON.parse(readFileSync(p.config, "utf8")).pgPassword).toBe("known-postgres-secret");
  });

  it("leaves two unreadable copies untouched instead of generating replacement secrets", async () => {
    const root = userData();
    const p = paths(root);
    mkdirSync(path.dirname(p.config), { recursive: true });
    mkdirSync(p.pgdata, { recursive: true });
    writeFileSync(p.config, "not-json");
    writeFileSync(p.backup, "also-not-json");
    await expect(loadOrCreateConfig(root, { safeStorage })).rejects.toMatchObject({ stage: "configuration" });
    expect(readFileSync(p.config, "utf8")).toBe("not-json");
    expect(readFileSync(p.backup, "utf8")).toBe("also-not-json");
  });
});
