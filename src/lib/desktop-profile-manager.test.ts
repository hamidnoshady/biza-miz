/**
 * electron/profile-manager.js — the one-active-backend guarantee (issue #1571 /
 * ESH-222).
 *
 * The real lifecycle starts an embedded PostgreSQL cluster and a Next.js server,
 * so it is covered by the packaged smoke test rather than here. What CAN be
 * tested — and what actually carries the risk — is the ordering: never two
 * backends, always drain before start, serialize concurrent requests, and roll
 * back to a working business when the target cannot start. A fake backend
 * factory records exactly that.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ProfileManager, ProfileSwitchError } = require("../../electron/profile-manager.js") as {
  ProfileManager: new (options: Record<string, unknown>) => Manager;
  ProfileSwitchError: new (...args: never[]) => Error & {
    code: string;
    rollback: { attempted: boolean; ok: boolean };
    cause?: unknown;
  };
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
  switchTo: (profile: Profile) => Promise<Record<string, unknown>>;
  stop: () => Promise<{ stopped: boolean }>;
  status: () => { activeProfileId: string | null; running: boolean; generation: number };
  isRunning: boolean;
  generation: number;
  activeProfile: Profile | null;
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

const PROFILE_A: Profile = { id: UUID_A, displayName: "کسب‌وکار الف", mode: "cloud" };
const PROFILE_B: Profile = { id: UUID_B, displayName: "کسب‌وکار ب", mode: "hybrid" };
const PROFILE_C: Profile = { id: UUID_C, displayName: "کسب‌وکار ج", mode: "local" };

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
    expect(manager.status()).toMatchObject({ activeProfileId: UUID_A, running: true, generation: 1 });
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

  it("stops the active backend and clears the active profile", async () => {
    const { manager, stats } = harness();
    await manager.start(PROFILE_A);
    const result = await manager.stop();
    expect(result.stopped).toBe(true);
    expect(manager.isRunning).toBe(false);
    expect(manager.status().activeProfileId).toBeNull();
    expect(stats().live).toBe(0);
  });
});

describe("switching business", () => {
  it("drains the current business before starting the next one", async () => {
    const { manager, created, stats } = harness();
    await manager.start(PROFILE_A);

    const switched = await manager.switchTo(PROFILE_B);

    expect(switched.switched).toBe(true);
    expect(manager.status()).toMatchObject({ activeProfileId: UUID_B, generation: 2 });
    // A was stopped, B was started, and they were never live at the same time.
    expect(created[0].stopped).toBe(true);
    expect(created[1].started).toBe(true);
    expect(stats()).toEqual({ live: 1, maxLive: 1 });
  });

  it("is a no-op when the requested business is already the active one", async () => {
    const { manager, created } = harness();
    await manager.start(PROFILE_A);
    const result = await manager.switchTo(PROFILE_A);
    expect(result.switched).toBe(false);
    expect(created).toHaveLength(1);
  });

  it("serializes concurrent switches so two backends can never overlap", async () => {
    const { manager, stats } = harness();
    await manager.start(PROFILE_A);

    // Two clicks in the same tick: the second must run only after the first.
    const results = await Promise.all([manager.switchTo(PROFILE_B), manager.switchTo(PROFILE_C)]);

    expect(results).toHaveLength(2);
    expect(manager.status().activeProfileId).toBe(UUID_C);
    expect(stats().maxLive).toBe(1);
    expect(stats().live).toBe(1);
  });

  it("rolls back to the previous business when the target cannot start", async () => {
    const { manager, created, failStartFor } = harness();
    await manager.start(PROFILE_A);
    failStartFor.add(UUID_B);

    const failure = await manager.switchTo(PROFILE_B).catch((error: unknown) => error as InstanceType<typeof ProfileSwitchError>);

    expect(failure).toBeInstanceOf(ProfileSwitchError);
    expect(failure.code).toBe("profile_switch_failed");
    expect(failure.rollback).toMatchObject({ attempted: true, ok: true });
    // The previous business is running again, through a NEW backend: a manager
    // whose stop() ran has a sticky stopRequested and cannot be restarted.
    expect(manager.status()).toMatchObject({ activeProfileId: UUID_A, running: true });
    const last = created[created.length - 1];
    expect(last.profileId).toBe(UUID_A);
    expect(last.started).toBe(true);
  });

  it("reports an unrecoverable rollback instead of pretending the app is usable", async () => {
    const { manager, failStartFor } = harness();
    await manager.start(PROFILE_A);
    failStartFor.add(UUID_A);
    failStartFor.add(UUID_B);

    const failure = await manager.switchTo(PROFILE_B).catch((error: unknown) => error as InstanceType<typeof ProfileSwitchError>);

    expect(failure.rollback).toMatchObject({ attempted: true, ok: false });
    expect(manager.isRunning).toBe(false);
    expect(manager.status().activeProfileId).toBeNull();
  });

  it("changes the generation on every successful start, so stale work can tell", async () => {
    const { manager } = harness();
    await manager.start(PROFILE_A);
    const first = manager.generation;
    await manager.switchTo(PROFILE_B);
    expect(manager.generation).toBe(first + 1);
  });
});
