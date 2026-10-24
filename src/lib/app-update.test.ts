/**
 * Issue #1008 — the on-demand Desktop update check.
 *
 * The settings button used to only re-read `GET /api/desktop-update/status`
 * and hand its cached `targetRelease` to the engine. With nothing pushed by
 * the 30-second sync tick that was `check(null)`, which the engine answers
 * «no update» without a network call. These tests pin the replacement: every
 * manual check performs the authenticated runtime-status exchange itself, and
 * an unreachable Central is reported as offline rather than as "up to date".
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopReleaseManifest } from "./desktop-release";
import type { AppUpdateStatus } from "./app-update";

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    query: vi.fn(async () => ({ rows: [{ filename: "0190_desktop_release.sql" }] })),
    getSetting: vi.fn(async (_businessId: string, key: string) => store.get(key) ?? null),
    setSetting: vi.fn(async (_businessId: string, key: string, value: unknown) => {
      store.set(key, value);
    }),
  };
});

vi.mock("./db", () => ({ query: mocks.query }));
vi.mock("./settings", () => ({
  SETTING_KEYS: { appUpdateStatus: "app_update.status", desktopUpdatePolicy: "desktop_update.policy" },
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

import { checkDesktopUpdateNow, summarizeUpdateCheck } from "./app-update";

const CONFIG = {
  enabled: true,
  remoteUrl: "https://central.example",
  token: "POS1-site-token",
};

const MANIFEST: DesktopReleaseManifest = {
  manifestSignature: "A".repeat(96),
  version: "1.0.69",
  buildCommit: "b".repeat(40),
  buildId: "production-169",
  channel: "stable",
  releasedAt: "2026-10-17T08:00:00.000Z",
  minimumSupportedVersion: "1.0.0",
  mandatory: false,
  installer: {
    url: "https://github.com/example/product/update.exe",
    sha256: "c".repeat(64),
    size: 4096,
    signatureRequired: true,
    expectedPublisher: "Business Suite",
  },
  database: {
    migrationVersion: 227,
    minimumSchemaVersion: 1,
    maximumSchemaVersion: 227,
    backupRequired: true,
  },
  releaseNotes: ["رفع اشکال بررسی به‌روزرسانی"],
  recovery: { knownGoodVersion: null, notes: null },
};

const status = (over: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  checkedAt: "2026-10-18T09:30:00.000Z",
  installed: { version: "1.0.60", buildCommit: "abc1234", buildId: "desktop-1.0.60", channel: "stable" },
  centralRuntime: null,
  targetRelease: null,
  compliance: "up_to_date",
  error: null,
  currentVersion: "1.0.60",
  latestVersion: null,
  updateAvailable: false,
  ...over,
});

function centralAnswer(body: Record<string, unknown>, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json" },
  });
}

const answer = (targetRelease: DesktopReleaseManifest | null, reportedAt = "2026-10-18T09:31:00.000Z") =>
  centralAnswer({
    centralRuntime: { releaseVersion: null, commitSha: null, buildId: null },
    targetRelease,
    updatePolicy: null,
    reportedAt,
  });

let root = "";
const ENV_KEYS = ["APP_RELEASE_VERSION", "APP_BUILD_COMMIT", "DESKTOP_RELEASE_CHANNEL", "DESKTOP_UPDATE_TARGET_PATH", "DESKTOP_UPDATE_POLICY_PATH", "DESKTOP_UPDATE_COMMAND_PATH", "DESKTOP_UPDATE_STATE_PATH"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.store.clear();
  root = await mkdtemp(path.join(os.tmpdir(), "desktop-update-check-"));
  process.env.APP_RELEASE_VERSION = "1.0.60";
  process.env.APP_BUILD_COMMIT = "abc1234";
  process.env.DESKTOP_RELEASE_CHANNEL = "stable";
  process.env.DESKTOP_UPDATE_TARGET_PATH = path.join(root, "update-target.json");
  delete process.env.DESKTOP_UPDATE_POLICY_PATH;
  delete process.env.DESKTOP_UPDATE_STATE_PATH;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("checkDesktopUpdateNow", () => {
  it("asks Central and surfaces a release the sync tick never pushed", async () => {
    const fetchMock = vi.fn(async () => answer(MANIFEST));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkDesktopUpdateNow("biz-1", CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://central.example/api/server-sync/runtime-status");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer POS1-site-token");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ appVersion: "1.0.60", releaseChannel: "stable", schemaVersion: 190 });

    expect(result.outcome).toBe("update_available");
    expect(result.offline).toBe(false);
    expect(result.error).toBeNull();
    expect(result.checkedAt).toBe("2026-10-18T09:31:00.000Z");
    expect(result.targetRelease?.version).toBe("1.0.69");

    // The same atomically written handoff the tick produces, so the engine can
    // still consume it with the settings page closed.
    const handoff = JSON.parse(await readFile(process.env.DESKTOP_UPDATE_TARGET_PATH!, "utf8")) as { version: string };
    expect(handoff.version).toBe("1.0.69");

    // The status the screen reads back carries the fresh target and time.
    expect(mocks.setSetting).toHaveBeenCalled();
    const stored = mocks.store.get("app_update.status") as AppUpdateStatus;
    expect(stored.targetRelease?.version).toBe("1.0.69");
    expect(stored.checkedAt).toBe("2026-10-18T09:31:00.000Z");
  });

  it("really asks every time instead of trusting the previously cached answer", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(answer(null))
      .mockResolvedValueOnce(answer(MANIFEST)));

    const first = await checkDesktopUpdateNow("biz-1", CONFIG);
    const second = await checkDesktopUpdateNow("biz-1", CONFIG);

    expect(first.outcome).toBe("up_to_date");
    expect(second.outcome).toBe("update_available");
    expect(second.targetRelease?.version).toBe("1.0.69");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("reports an unreachable Central as offline, never as 'up to date'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));

    const result = await checkDesktopUpdateNow("biz-1", CONFIG);

    expect(result).toMatchObject({ outcome: "offline", offline: true, error: "remote_unreachable", targetRelease: null });
    expect(result.status.error).toBe("remote_unreachable");
    expect(result.outcome).not.toBe("up_to_date");
  });

  it("keeps a timeout separate from the offline hint", async () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeout; }));

    const result = await checkDesktopUpdateNow("biz-1", CONFIG);

    expect(result).toMatchObject({ outcome: "error", offline: false, error: "remote_timeout" });
  });

  it("surfaces Central's refusal instead of inventing an up-to-date answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => centralAnswer({ error: "unauthorized" }, { status: 401 })));

    const result = await checkDesktopUpdateNow("biz-1", CONFIG);

    expect(result).toMatchObject({ outcome: "error", offline: false, error: "remote_rejected_401" });
  });

  it("does not call Central at all when the install is not paired", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkDesktopUpdateNow("biz-1", null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "error", offline: false, error: "sync_not_configured" });
  });
});

describe("summarizeUpdateCheck", () => {
  it("maps a newer target to update_available and carries the manifest", () => {
    expect(summarizeUpdateCheck(status({ targetRelease: MANIFEST, compliance: "update_available", updateAvailable: true, latestVersion: "1.0.69" }))).toMatchObject({
      outcome: "update_available",
      offline: false,
      error: null,
      targetRelease: MANIFEST,
    });
  });

  it("maps a same-version target to up_to_date", () => {
    expect(summarizeUpdateCheck(status()).outcome).toBe("up_to_date");
  });

  it("classifies only a transport failure as offline", () => {
    expect(summarizeUpdateCheck(status({ error: "remote_unreachable", compliance: "error" }))).toMatchObject({
      outcome: "offline",
      offline: true,
    });
    expect(summarizeUpdateCheck(status({ error: "remote_timeout", compliance: "error" }))).toMatchObject({
      outcome: "error",
      offline: false,
    });
  });
});
