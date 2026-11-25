/**
 * electron/profile-registry.js — the desktop multi-business foundation
 * (issue #1571 / ESH-222).
 *
 * The migration tests run real filesystem operations against a throwaway
 * directory under `os.tmpdir()` (the same convention as app-paths.test.ts and
 * local-storage.test.ts); the failure path is covered with an injected `fs`
 * whose `renameSync` refuses one specific move, because "the disk gave up
 * halfway through moving a business's database" is exactly the scenario a
 * migration must survive and exactly the one a real disk will not reproduce on
 * demand.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const registryModule = require("../../electron/profile-registry.js") as {
  REGISTRY_FORMAT: string;
  REGISTRY_SCHEMA_VERSION: number;
  MAX_PROFILES: number;
  isProfileId: (value: unknown) => boolean;
  registryPath: (installRoot: string) => string;
  profileDataDir: (installRoot: string, profileId: string) => string;
  emptyRegistry: () => Registry;
  validateProfile: (raw: unknown) => Record<string, unknown> | null;
  validateRegistry: (raw: unknown) => Registry | null;
  readRegistry: (installRoot: string, fsImpl?: unknown) => { state: string; registry: Registry | null };
  writeRegistry: (installRoot: string, registry: Registry, fsImpl?: unknown) => Registry;
  createProfile: (input?: Record<string, unknown>, now?: Date) => Profile;
  addProfile: (registry: Registry, input: Record<string, unknown>, now?: Date) => { ok: boolean; error?: string; profile?: Profile; registry?: Registry };
  removeProfile: (registry: Registry, id: string) => { ok: boolean; removed?: Profile; registry?: Registry };
  selectProfile: (registry: Registry, id: string, now?: Date) => { ok: boolean; registry?: Registry; profile?: Profile };
  planLegacyImport: (installRoot: string, registry: Registry, fsImpl?: unknown) => { needed: boolean; reason?: string; entries?: Array<{ key: string; name: string; source: string }> };
  importLegacyInstall: (options: Record<string, unknown>) => {
    ok: boolean;
    imported?: boolean;
    reason?: string;
    profile?: Profile;
    registry?: Registry;
    moved?: string[];
    rolledBack?: boolean;
    rollbackFailures?: unknown[];
    error?: string;
  };
  deleteProfileData: (installRoot: string, profileId: string, fsImpl?: unknown) => { ok: boolean; deleted: boolean };
  profileHasData: (installRoot: string, profileId: string, fsImpl?: unknown) => boolean;
};

interface Profile {
  id: string;
  displayName: string;
  businessName: string | null;
  businessId: string | null;
  businessSubdomain: string | null;
  cloudOrigin: string | null;
  mode: string;
  source: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Registry {
  format: string;
  schemaVersion: number;
  lastUsedProfileId: string | null;
  profiles: Profile[];
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bizamiz-profiles-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A registry seeded with one valid profile, for the mutation tests. */
function seeded(count = 1): Registry {
  let registry = registryModule.emptyRegistry();
  for (let index = 0; index < count; index += 1) {
    const added = registryModule.addProfile(registry, { displayName: `کسب‌وکار ${index + 1}` });
    expect(added.ok).toBe(true);
    registry = added.registry as Registry;
  }
  return registry;
}

/** Real fs, except `renameSync` refuses the moves the predicate selects. */
function fsRefusingRenames(predicate: (src: string, dest: string) => boolean): typeof fs {
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === "renameSync") {
        return (src: string, dest: string) => {
          if (predicate(String(src), String(dest))) throw new Error("injected_move_failure");
          return (target.renameSync as (a: string, b: string) => void)(src, dest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as typeof fs;
}

describe("profile ids and directories", () => {
  it("accepts only a real UUID as a profile id", () => {
    expect(registryModule.isProfileId(UUID_A)).toBe(true);
    expect(registryModule.isProfileId("not-a-uuid")).toBe(false);
    expect(registryModule.isProfileId("../../Windows")).toBe(false);
    expect(registryModule.isProfileId("")).toBe(false);
  });

  it("refuses to turn a crafted id into a path", () => {
    expect(() => registryModule.profileDataDir(root, "../../Windows/System32")).toThrow(/Invalid desktop profile id/);
  });

  it("puts every profile under businesses/<uuid>", () => {
    expect(registryModule.profileDataDir(root, UUID_A)).toBe(path.join(root, "businesses", UUID_A));
  });

  it("keeps the registry beside the folders it indexes", () => {
    expect(registryModule.registryPath(root)).toBe(path.join(root, "business-profiles.json"));
  });
});

describe("registry records", () => {
  it("has no plaintext credential field, and refuses a record that carries one", () => {
    const profile = registryModule.createProfile({ displayName: "فروشگاه یک" });
    expect(registryModule.validateProfile(profile)).not.toBeNull();
    for (const forbidden of ["password", "pgPassword", "jwtSecret", "masterKey", "token", "session"]) {
      expect(registryModule.validateProfile({ ...profile, [forbidden]: "hunter2" }), forbidden).toBeNull();
    }
  });

  it("refuses unknown fields, so the schema stays closed", () => {
    const profile = registryModule.createProfile({ displayName: "فروشگاه یک" });
    expect(registryModule.validateProfile({ ...profile, extra: "value" })).toBeNull();
  });

  it("accepts only an https origin with no path, query or userinfo", () => {
    const base = registryModule.createProfile({ displayName: "فروشگاه یک" });
    expect(registryModule.validateProfile({ ...base, cloudOrigin: "https://a.example.com" })?.cloudOrigin).toBe(
      "https://a.example.com",
    );
    for (const bad of [
      "http://a.example.com",
      "https://a.example.com/path",
      "https://a.example.com/?q=1",
      "https://user:pass@a.example.com",
      "javascript:alert(1)",
    ]) {
      expect(registryModule.validateProfile({ ...base, cloudOrigin: bad }), bad).toBeNull();
    }
  });

  it("normalises a subdomain and refuses a hostname-shaped one", () => {
    const base = registryModule.createProfile({ displayName: "فروشگاه یک" });
    expect(registryModule.validateProfile({ ...base, businessSubdomain: "Cafe-One" })?.businessSubdomain).toBe(
      "cafe-one",
    );
    for (const bad of ["cafe.example.com", "-cafe", "café"]) {
      expect(registryModule.validateProfile({ ...base, businessSubdomain: bad }), bad).toBeNull();
    }
  });

  it("requires a display name", () => {
    expect(() => registryModule.createProfile({ displayName: "   " })).toThrow(/display name/);
  });
});

describe("registry persistence", () => {
  it("round-trips a registry through an atomic write", () => {
    const registry = seeded(2);
    const written = registryModule.writeRegistry(root, registry);
    const read = registryModule.readRegistry(root);
    expect(read.state).toBe("ok");
    expect(read.registry?.profiles).toHaveLength(2);
    expect(written.profiles[0].id).toBe(read.registry?.profiles[0].id);
    // Owner-readable only, like config.json and server.pid.
    expect(fs.statSync(registryModule.registryPath(root)).mode & 0o777).toBe(0o600);
  });

  it("reports a missing registry without inventing one", () => {
    const read = registryModule.readRegistry(root);
    expect(read.state).toBe("missing");
    expect(read.registry?.profiles).toEqual([]);
  });

  it("reports a corrupt registry instead of silently replacing it", () => {
    fs.writeFileSync(registryModule.registryPath(root), "{ not json");
    expect(registryModule.readRegistry(root).state).toBe("unreadable");
    expect(fs.readFileSync(registryModule.registryPath(root), "utf8")).toBe("{ not json");
  });

  it("reports a registry from a newer schema as invalid rather than guessing", () => {
    fs.writeFileSync(
      registryModule.registryPath(root),
      JSON.stringify({ ...registryModule.emptyRegistry(), schemaVersion: registryModule.REGISTRY_SCHEMA_VERSION + 1 }),
    );
    expect(registryModule.readRegistry(root).state).toBe("invalid");
  });

  it("invalidates the whole registry when one record is malformed, so no business is dropped", () => {
    const registry = seeded(1);
    const broken = {
      ...registry,
      profiles: [{ ...registry.profiles[0], id: "not-a-uuid" }],
    };
    fs.writeFileSync(registryModule.registryPath(root), JSON.stringify(broken));
    expect(registryModule.readRegistry(root).state).toBe("invalid");
  });

  it("heals a dangling last-used pointer instead of bricking startup", () => {
    const registry = { ...seeded(1), lastUsedProfileId: UUID_B };
    fs.writeFileSync(registryModule.registryPath(root), JSON.stringify(registry));
    const read = registryModule.readRegistry(root);
    expect(read.state).toBe("ok");
    expect(read.registry?.lastUsedProfileId).toBeNull();
  });

  it("refuses to write an invalid registry", () => {
    const registry = seeded(1);
    expect(() =>
      registryModule.writeRegistry(root, { ...registry, profiles: [{ ...registry.profiles[0], id: "x" }] } as Registry),
    ).toThrow(/invalid desktop business profile registry/i);
  });
});

describe("registry mutations", () => {
  it("refuses the same enrolled business twice but allows two unenrolled profiles", () => {
    let registry = registryModule.emptyRegistry();
    const first = registryModule.addProfile(registry, {
      displayName: "یک",
      businessId: UUID_A,
      cloudOrigin: "https://a.example.com",
    });
    registry = first.registry as Registry;

    expect(
      registryModule.addProfile(registry, {
        displayName: "یک (تکراری)",
        businessId: UUID_A,
        cloudOrigin: "https://a.example.com",
      }).error,
    ).toBe("duplicate_business");

    // Neither has enrolled yet, so there is no identity to compare.
    expect(registryModule.addProfile(registry, { displayName: "دو" }).ok).toBe(true);
  });

  it("caps the number of saved profiles", () => {
    let registry = registryModule.emptyRegistry();
    for (let index = 0; index < registryModule.MAX_PROFILES; index += 1) {
      const added = registryModule.addProfile(registry, { displayName: `کسب‌وکار ${index}` });
      expect(added.ok).toBe(true);
      registry = added.registry as Registry;
    }
    expect(registryModule.addProfile(registry, { displayName: "یکی زیاد" }).error).toBe("profile_limit");
  });

  it("removes a profile from the index and clears pointers at it", () => {
    const registry = seeded(2);
    const [first, second] = registry.profiles;
    const selected = registryModule.selectProfile(registry, first.id).registry as Registry;
    const removed = registryModule.removeProfile(selected, first.id);
    expect(removed.ok).toBe(true);
    expect(removed.registry?.profiles.map((profile) => profile.id)).toEqual([second.id]);
    expect(removed.registry?.lastUsedProfileId).toBeNull();
  });
});

describe("legacy single-business install migration", () => {
  function seedLegacyInstall() {
    fs.mkdirSync(path.join(root, "Configuration"), { recursive: true });
    fs.writeFileSync(path.join(root, "Configuration", "config.json"), JSON.stringify({ instanceId: "legacy" }));
    fs.mkdirSync(path.join(root, "Data", "pgdata"), { recursive: true });
    fs.writeFileSync(path.join(root, "Data", "pgdata", "PG_VERSION"), "16");
    fs.mkdirSync(path.join(root, "Logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "Logs", "desktop.log"), "legacy log line");
  }

  it("imports the whole legacy root as the first profile", () => {
    seedLegacyInstall();
    const registry = registryModule.emptyRegistry();
    const plan = registryModule.planLegacyImport(root, registry);
    expect(plan.needed).toBe(true);
    expect(plan.entries?.map((entry) => entry.name)).toEqual(["Configuration", "Data", "Logs"]);

    const result = registryModule.importLegacyInstall({ installRoot: root, registry });
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(true);
    expect(result.moved).toEqual(["Configuration", "Data", "Logs"]);

    const profileRoot = registryModule.profileDataDir(root, result.profile!.id);
    expect(fs.readFileSync(path.join(profileRoot, "Configuration", "config.json"), "utf8")).toContain("legacy");
    expect(fs.readFileSync(path.join(profileRoot, "Data", "pgdata", "PG_VERSION"), "utf8")).toBe("16");
    expect(fs.readFileSync(path.join(profileRoot, "Logs", "desktop.log"), "utf8")).toBe("legacy log line");

    // Nothing is left at the installation root, and the registry names the profile.
    expect(fs.existsSync(path.join(root, "Configuration"))).toBe(false);
    expect(fs.existsSync(path.join(root, "Data"))).toBe(false);
    expect(result.profile?.source).toBe("legacy");
    const read = registryModule.readRegistry(root);
    expect(read.state).toBe("ok");
    expect(read.registry?.profiles[0].id).toBe(result.profile!.id);
  });

  it("does nothing when there is no legacy data and no profile", () => {
    const result = registryModule.importLegacyInstall({ installRoot: root, registry: registryModule.emptyRegistry() });
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(false);
    expect(result.reason).toBe("no_legacy_data");
  });

  it("never imports twice", () => {
    seedLegacyInstall();
    const first = registryModule.importLegacyInstall({ installRoot: root, registry: registryModule.emptyRegistry() });
    expect(first.ok).toBe(true);
    const second = registryModule.importLegacyInstall({ installRoot: root, registry: first.registry! });
    expect(second.ok).toBe(true);
    expect(second.imported).toBe(false);
    expect(second.reason).toBe("registry_has_profiles");
  });

  it("moves everything back when a move fails halfway, so the install still works", () => {
    seedLegacyInstall();
    const injected = fsRefusingRenames((src) => src.endsWith(`${path.sep}Data`));
    const result = registryModule.importLegacyInstall({
      installRoot: root,
      registry: registryModule.emptyRegistry(),
      fsImpl: injected,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("move_failed");
    expect(result.rolledBack).toBe(true);
    // The config that had already moved is back where the old build looks for it.
    expect(fs.existsSync(path.join(root, "Configuration", "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "Data", "pgdata", "PG_VERSION"))).toBe(true);
    // No half-migrated index, and no orphan profile directory.
    expect(registryModule.readRegistry(root).state).toBe("missing");
    const profilesRoot = path.join(root, "businesses");
    expect(fs.existsSync(profilesRoot) ? fs.readdirSync(profilesRoot) : []).toEqual([]);
  });

  it("reports an unrecoverable rollback instead of claiming success", () => {
    seedLegacyInstall();
    // Fail the Data move, then refuse to move Configuration back too.
    const injected = fsRefusingRenames((src) => src.endsWith(`${path.sep}Data`) || src.includes(`${path.sep}businesses${path.sep}`));
    const result = registryModule.importLegacyInstall({
      installRoot: root,
      registry: registryModule.emptyRegistry(),
      fsImpl: injected,
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackFailures?.length).toBeGreaterThan(0);
  });
});

describe("profile data", () => {
  it("deletes only the named profile's directory", () => {
    const registry = seeded(2);
    const [first, second] = registry.profiles;
    for (const profile of [first, second]) {
      const directory = registryModule.profileDataDir(root, profile.id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "marker"), profile.id);
    }

    expect(registryModule.deleteProfileData(root, first.id).deleted).toBe(true);
    expect(fs.existsSync(registryModule.profileDataDir(root, first.id))).toBe(false);
    expect(fs.existsSync(registryModule.profileDataDir(root, second.id))).toBe(true);
  });

  it("reports whether a profile holds data, which the removal confirmation needs", () => {
    const registry = seeded(1);
    const id = registry.profiles[0].id;
    expect(registryModule.profileHasData(root, id)).toBe(false);
    fs.mkdirSync(path.join(registryModule.profileDataDir(root, id), "Data", "pgdata"), { recursive: true });
    expect(registryModule.profileHasData(root, id)).toBe(true);
  });
});
