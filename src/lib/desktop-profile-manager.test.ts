/**
 * electron/profile-manager.js — the one-active-backend guarantee (issue #1571 /
 * ESH-222).
 *
 * The real lifecycle starts an embedded PostgreSQL cluster and a Next.js server,
 * so it is covered by the packaged smoke test rather than here. What CAN be
 * tested — and what actually carries the risk — is the ordering: never two
 * backends, always drain before the next start, serialize a quit that races the
 * boot, and leave nothing half-running when a start fails. A fake backend factory
 * records exactly that.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ProfileManager } = require("../../electron/profile-manager.js") as {
  ProfileManager: new (options: Record<string, unknown>) => Manager;
};

interface Profile {
  id: string;
  displayName: string;
  mode: string;
}

interface FakeBackend {
  profileId: string;
  started: boolean;
  stopped: boolean;
  serverAppUrl: string;
  start: () => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
}

interface Manager {
  start: (profile: Profile) => Promise<Record<string, unknown>>;
  stop: () => Promise<{ stopped: boolean }>;
  status: () => { activeProfileId: string | null; running: boolean };
  isRunning: boolean;
  activeProfile: Profile | null;
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const PROFILE_A: Profile = { id: UUID_A, displayName: "کسب‌وکار الف", mode: "cloud" };
const PROFILE_B: Profile = { id: UUID_B, displayName: "کسب‌وکار ب", mode: "hybrid" };

/**
 * A manager whose backends are recorded rather than started. `live` counts
 * backends that are started and not stopped, so `maxLive` is the direct
 * assertion for "only one active local backend at a time".
 */
function harness() {
  const created: FakeBackend[] = [];
  const failStartFor = new Set<string>();
  let live = 0;
  let maxLive = 0;

  const backendFactory = (profile: Profile) => {
    const backend: FakeBackend = {
      profileId: profile.id,
      started: false,
      stopped: false,
      serverAppUrl: `http://127.0.0.1:${3100 + created.length}`,
      async start() {
        if (failStartFor.has(profile.id)) throw new Error(`start_failed:${profile.id}`);
        backend.started = true;
        live += 1;
        maxLive = Math.max(maxLive, live);
        return {
          appUrl: backend.serverAppUrl,
          config: { appPort: 3100 + created.length },
          configPath: `config-${profile.id}.json`,
          userDataDir: `/data/${profile.id}`,
        };
      },
      async stop() {
        backend.stopped = true;
        if (backend.started) {
          backend.started = false;
          live -= 1;
        }
      },
    };
    created.push(backend);
    return backend;
  };

  const manager = new ProfileManager({
    app: {},
    logger: undefined,
    safeStorage: undefined,
    installRoot: "/install-root",
    backendFactory,
  });

  return { manager, created, failStartFor, stats: () => ({ live, maxLive }) };
}

describe("starting a business", () => {
  it("starts one backend and reports it as the active business", async () => {
    const { manager, created, stats } = harness();
    expect(manager.isRunning).toBe(false);

    const started = await manager.start(PROFILE_A);

    expect(started.profile).toMatchObject({ id: UUID_A });
    expect(manager.isRunning).toBe(true);
    expect(manager.status()).toMatchObject({ activeProfileId: UUID_A, running: true });
    expect(created).toHaveLength(1);
    expect(stats()).toEqual({ live: 1, maxLive: 1 });
  });

  it("refuses a second backend instead of running two", async () => {
    const { manager, created, stats } = harness();
    await manager.start(PROFILE_A);
    await expect(manager.start(PROFILE_B)).rejects.toMatchObject({ code: "profile_already_running" });
    expect(created).toHaveLength(1);
    expect(stats().maxLive).toBe(1);
  });

  it("leaves nothing running when the start fails, and releases its backend", async () => {
    const { manager, created, failStartFor, stats } = harness();
    failStartFor.add(UUID_A);

    await expect(manager.start(PROFILE_A)).rejects.toThrow(/start_failed/);

    expect(manager.isRunning).toBe(false);
    expect(manager.status().activeProfileId).toBeNull();
    // The half-started backend was told to stop rather than orphaned.
    expect(created).toHaveLength(1);
    expect(created[0].stopped).toBe(true);
    expect(stats().live).toBe(0);
  });

  it("stops the active backend and clears the active profile", async () => {
    const { manager, stats } = harness();
    await manager.start(PROFILE_A);
    const result = await manager.stop();
    expect(result.stopped).toBe(true);
    expect(manager.isRunning).toBe(false);
    expect(manager.status().activeProfileId).toBeNull();
    expect(stats().live).toBe(0);
  });

  it("serializes a quit that arrives while the start is still in flight", async () => {
    const { manager } = harness();
    // A quit during the boot: the stop must wait for the start, then stop it,
    // and never leave two backends or a running one behind.
    const starting = manager.start(PROFILE_A);
    const stopping = manager.stop();
    await expect(starting).resolves.toMatchObject({ profile: { id: UUID_A } });
    await expect(stopping).resolves.toMatchObject({ stopped: true });
    expect(manager.isRunning).toBe(false);
    expect(manager.status().activeProfileId).toBeNull();
  });
});
