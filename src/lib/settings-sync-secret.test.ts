import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./db", () => ({ query: mocks.query }));

import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { resetMasterKeyCache, setMasterKeyOverride } from "./master-key";
import { sealServerSyncConfig } from "./server-sync-secret";

const CONFIG = { remoteUrl: "https://cloud.example.com", token: "plain-sync-token", enabled: true };

beforeEach(() => {
  vi.resetAllMocks();
  setMasterKeyOverride(randomBytes(32));
});
afterEach(() => {
  setMasterKeyOverride(null);
  resetMasterKeyCache();
});

describe("settings server_sync.config encryption boundary", () => {
  it("atomically migrates legacy plaintext on first read", async () => {
    let stored: Record<string, unknown> | null = null;
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.startsWith("SELECT")) return { rows: [{ value: CONFIG }] };
      if (sql.startsWith("UPDATE")) {
        stored = JSON.parse(String(params[2]));
        return { rows: [{ value: stored }] };
      }
      throw new Error("unexpected query");
    });
    await expect(getSetting("business-1", SETTING_KEYS.serverSyncConfig)).resolves.toEqual(CONFIG);
    expect(stored).not.toBeNull();
    expect(stored!.token).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(CONFIG.token);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("re-reads a concurrently changed row instead of overwriting it", async () => {
    const latest = sealServerSyncConfig({ ...CONFIG, token: "rotated-token" });
    let selects = 0;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT")) {
        selects += 1;
        return { rows: [{ value: selects === 1 ? CONFIG : latest }] };
      }
      return { rows: [] };
    });
    await expect(getSetting("business-1", SETTING_KEYS.serverSyncConfig)).resolves.toMatchObject({ token: "rotated-token" });
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("seals every new write", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await setSetting("business-1", SETTING_KEYS.serverSyncConfig, CONFIG);
    const stored = JSON.parse(mocks.query.mock.calls[0][1][2]);
    expect(stored.token).toBeUndefined();
    expect(stored.tokenCiphertext).toMatch(/^mk1\./);
  });
});
