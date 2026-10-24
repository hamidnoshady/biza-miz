/**
 * Issue #1001 — the packaged smoke probe must not be a production backdoor.
 *
 * It can create an owner account with a hardcoded password. It now lives
 * outside `electron/main.js`, runs only in smoke mode, and refuses the
 * account-creating path in a packaged build unless the (unshipped) smoke
 * harness opts in explicitly. The marker still has to be written for the
 * harness to accept a launch.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { mayBootstrap, runSmokeProbe } = require("../../electron/smoke-probe.js") as {
  mayBootstrap: (options?: { env?: Record<string, string | undefined>; isPackaged?: boolean }) => boolean;
  runSmokeProbe: (options: {
    appUrl: string;
    userDataDir: string;
    instanceId: string;
    env: Record<string, string | undefined>;
    isPackaged?: boolean;
    fetchImpl?: typeof fetch;
    writeMarker?: (contents: string) => void;
  }) => Promise<{ ok: boolean; needsBootstrap: boolean; authenticated: boolean; instanceId: string; pgdata: boolean }>;
};

const temporaryDirs: string[] = [];
function temporaryDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desktop-smoke-probe-"));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mayBootstrap", () => {
  it("needs the bootstrap switch, and in a packaged build the harness opt-in too", () => {
    expect(mayBootstrap({ env: {}, isPackaged: true })).toBe(false);
    expect(mayBootstrap({ env: { DESKTOP_SMOKE_BOOTSTRAP: "1" }, isPackaged: true })).toBe(false);
    expect(mayBootstrap({ env: { DESKTOP_SMOKE_BOOTSTRAP: "1", DESKTOP_SMOKE_PACKAGED_PROBE: "1" }, isPackaged: true })).toBe(true);
    // An unpackaged (electron .) run keeps the old convenience.
    expect(mayBootstrap({ env: { DESKTOP_SMOKE_BOOTSTRAP: "1" }, isPackaged: false })).toBe(true);
    expect(mayBootstrap({ env: { DESKTOP_SMOKE_BOOTSTRAP: "0" }, isPackaged: false })).toBe(false);
  });
});

function stateResponse(body: Record<string, unknown>, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("runSmokeProbe", () => {
  it("writes its marker without creating an owner when bootstrap is not allowed", async () => {
    const userDataDir = temporaryDir();
    const writeMarker = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/api/setup/state");
      return stateResponse({ needsBootstrap: true });
    }) as unknown as typeof fetch;

    const result = await runSmokeProbe({
      appUrl: "http://127.0.0.1:3000",
      userDataDir,
      instanceId: "instance-1",
      env: { DESKTOP_SMOKE_MARKER: "/tmp/marker.json", DESKTOP_SMOKE_BOOTSTRAP: "1" },
      isPackaged: true,
      fetchImpl,
      writeMarker,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, needsBootstrap: true, authenticated: false, instanceId: "instance-1", pgdata: false });
    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeMarker.mock.calls[0][0])).toMatchObject({ ok: true, authenticated: false });
  });

  it("requires the marker variable at all", async () => {
    await expect(
      runSmokeProbe({
        appUrl: "http://127.0.0.1:3000",
        userDataDir: temporaryDir(),
        instanceId: "instance-1",
        env: {},
        fetchImpl: (async () => stateResponse({})) as unknown as typeof fetch,
        writeMarker: () => {},
      }),
    ).rejects.toThrow(/DESKTOP_SMOKE_MARKER/);
  });

  it("fails loudly when the app is not serving setup state", async () => {
    await expect(
      runSmokeProbe({
        appUrl: "http://127.0.0.1:3000",
        userDataDir: temporaryDir(),
        instanceId: "instance-1",
        env: { DESKTOP_SMOKE_MARKER: "/tmp/marker.json" },
        fetchImpl: (async () => stateResponse({}, false)) as unknown as typeof fetch,
        writeMarker: () => {},
      }),
    ).rejects.toThrow(/setup state returned HTTP 500/);
  });
});
