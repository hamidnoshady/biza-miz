/**
 * Issue #984 — the main-app half of the maintenance gate
 * (`electron/maintenance-gate.js`): claim lifecycle, lock probing,
 * heartbeat, installer handoff and stale cleanup, all against real temp
 * dirs. The true share-none contention is covered by the companion's .NET
 * tests on Windows CI plus the C# claim tests; here the OS refusal is
 * injected through the module's fs seam.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const gate = require("../electron/maintenance-gate.js") as {
  LOCK_FILE_NAME: string;
  CLAIM_PREFIX: string;
  CLAIM_SUFFIX: string;
  LOCK_OVERRIDE_VARIABLE: string;
  HEARTBEAT_MS: number;
  resolveLockPath(env?: Record<string, string | undefined>): string | null;
  parseClaimPid(fileName: string): number | null;
  probeLockFile(lockPath: string, opts?: { fs?: typeof fs }): "free" | "held";
  pidAlive(pid: number): boolean;
  cleanupStaleClaims(dir: string): number;
  acquireLock(opts?: {
    env?: Record<string, string | undefined>;
    fs?: typeof fs;
    heartbeatMs?: number;
  }): { ok: true; handle: GateHandle } | { ok: false; error: string };
};

interface GateHandle {
  lockPath: string;
  claimPath: string;
  pid: number;
  release(): { ok: true };
  handoff(installerPid: number | null): { ok: true; handedOff: boolean } | { ok: false; error: string };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("maintenance gate (issue #984)", () => {
  it("resolves the lock path from the override, ProgramData, or not at all", () => {
    expect(gate.resolveLockPath({ BIZA_MAINTENANCE_LOCK: " C:\\x\\y.lock " })).toBe("C:\\x\\y.lock");
    const viaProgramData = gate.resolveLockPath({ ProgramData: path.join("C:", "pd") });
    expect(viaProgramData).toBe(path.join("C:", "pd", "Biza", "maintenance.lock"));
    expect(gate.resolveLockPath({})).toBeNull();
  });

  it("parses only well-formed claim names", () => {
    expect(gate.parseClaimPid("maintenance.electron.123.claim")).toBe(123);
    expect(gate.parseClaimPid("maintenance.electron.xyz.claim")).toBeNull();
    expect(gate.parseClaimPid("maintenance.electron.0.claim")).toBeNull();
    expect(gate.parseClaimPid("maintenance.lock")).toBeNull();
  });

  it("probes a missing lock as free and an unreadable one as held", () => {
    const dir = tempDir();
    const missing = path.join(dir, "maintenance.lock");
    expect(gate.probeLockFile(missing)).toBe("free");

    const plain = path.join(dir, "plain.lock");
    fs.writeFileSync(plain, "stamp");
    expect(gate.probeLockFile(plain)).toBe("free");

    if (process.platform !== "win32") {
      const denied = path.join(dir, "denied.lock");
      fs.writeFileSync(denied, "stamp");
      fs.chmodSync(denied, 0o000);
      try {
        expect(gate.probeLockFile(denied)).toBe("held");
      } finally {
        fs.chmodSync(denied, 0o600);
      }
    }
  });

  it("claims and releases with a well-formed claim file", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, "Biza", "maintenance.lock");
    const acquired = gate.acquireLock({
      env: { BIZA_MAINTENANCE_LOCK: lockPath },
      heartbeatMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.handle.pid).toBe(process.pid);
    const body = fs.readFileSync(acquired.handle.claimPath, "utf8");
    expect(body).toContain(`pid=${process.pid}\n`);
    expect(body).toMatch(/^started=\S+/m);
    expect(body).toMatch(/^acquired=\S+/m);

    expect(acquired.handle.release()).toEqual({ ok: true });
    expect(fs.existsSync(acquired.handle.claimPath)).toBe(false);
  });

  it("refuses while the companion holds the lock and cleans its claim up", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, "maintenance.lock");
    const heldFs = {
      ...fs,
      openSync: ((p: string, ...rest: unknown[]) => {
        if (p === lockPath) {
          const err = new Error("resource busy") as Error & { code: string };
          err.code = "EBUSY";
          throw err;
        }
        return (fs.openSync as (...args: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync,
    };
    const acquired = gate.acquireLock({ env: { BIZA_MAINTENANCE_LOCK: lockPath }, fs: heldFs });
    expect(acquired).toEqual({ ok: false, error: "companion_maintenance_running" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reports an unwritable claim dir instead of throwing", () => {
    const dir = tempDir();
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    const acquired = gate.acquireLock({
      env: { BIZA_MAINTENANCE_LOCK: path.join(blocker, "maintenance.lock") },
    });
    expect(acquired).toEqual({ ok: false, error: "claim_unwritable" });
  });

  it("reports a missing lock dir instead of throwing", () => {
    expect(gate.acquireLock({ env: {} })).toEqual({ ok: false, error: "lock_dir_unavailable" });
  });

  it("heartbeats until released", async () => {
    const dir = tempDir();
    const lockPath = path.join(dir, "maintenance.lock");
    const acquired = gate.acquireLock({
      env: { BIZA_MAINTENANCE_LOCK: lockPath },
      heartbeatMs: 10,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const before = fs.statSync(acquired.handle.claimPath).mtimeMs;
    await sleep(60);
    const during = fs.statSync(acquired.handle.claimPath).mtimeMs;
    expect(during).toBeGreaterThan(before);

    acquired.handle.release();
    expect(fs.existsSync(acquired.handle.claimPath)).toBe(false);
  });

  it("hands the claim to the installer pid and leaves it on unknown pids", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, "maintenance.lock");
    const acquired = gate.acquireLock({
      env: { BIZA_MAINTENANCE_LOCK: lockPath },
      heartbeatMs: 0,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const oldPath = acquired.handle.claimPath;

    const installerPid = process.pid + 999_999;
    const handoff = acquired.handle.handoff(installerPid);
    expect(handoff).toEqual({ ok: true, handedOff: true });
    expect(fs.existsSync(oldPath)).toBe(false);
    const body = fs.readFileSync(acquired.handle.claimPath, "utf8");
    expect(body).toContain(`pid=${installerPid}\n`);
    expect(acquired.handle.claimPath).toContain(`maintenance.electron.${installerPid}.claim`);

    const kept = acquired.handle.handoff(null);
    expect(kept).toEqual({ ok: true, handedOff: false });
    expect(fs.existsSync(acquired.handle.claimPath)).toBe(true);
    acquired.handle.release();
  });

  it("cleans only dead-pid claims and nothing else", () => {
    const dir = tempDir();
    const dead = path.join(dir, "maintenance.electron.2147483647.claim");
    fs.writeFileSync(dead, "pid=2147483647\n");
    const live = path.join(dir, `maintenance.electron.${process.pid}.claim`);
    fs.writeFileSync(live, `pid=${process.pid}\n`);
    const foreign = path.join(dir, "notes.txt");
    fs.writeFileSync(foreign, "hi");

    expect(gate.pidAlive(process.pid)).toBe(true);
    expect(gate.pidAlive(2147483647)).toBe(false);
    expect(gate.cleanupStaleClaims(dir)).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
  });
});
