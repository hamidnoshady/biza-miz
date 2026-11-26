/**
 * #1572 follow-up — the shell's side of the backend-published identity.
 *
 * These are the tests that replaced "the renderer said so": a well-formed file
 * from a *different* profile's backend must not name this one, a document that
 * disagrees with a tenant the profile already holds must be refused rather than
 * written, and the registry stays non-secret whatever the file contains.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { instanceFingerprint as serverInstanceFingerprint } from "./desktop-identity-file";

const require = createRequire(import.meta.url);
const identityFile = require("../../electron/business-identity-file.js") as {
  businessIdentityPath: (profileRoot: string) => string;
  instanceFingerprint: (instanceId: string | null | undefined) => string | null;
  readBusinessIdentityFile: (
    file: string,
    expectedFingerprint: string | null,
    fsImpl?: unknown,
  ) => { state: string; identity: Identity | null; file: string };
};
const registryModule = require("../../electron/profile-registry.js") as {
  createProfile: (input: Record<string, unknown>, now?: Date) => RegistryProfile;
  recordProfileIdentity: (
    registry: Registry,
    profileId: string,
    identity: unknown,
  ) => { ok: boolean; changed?: boolean; error?: string; field?: string; registry?: Registry };
};

interface Identity {
  businessId: string;
  businessSubdomain: string | null;
  cloudOrigin: string | null;
}

interface RegistryProfile extends Identity {
  id: string;
  displayName: string;
  businessName: string | null;
  mode: string;
  source: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Registry {
  format: string;
  schemaVersion: number;
  lastUsedProfileId: string | null;
  profiles: RegistryProfile[];
}

const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const IDENTITY: Identity = {
  businessId: "11111111-1111-4111-8111-111111111111",
  businessSubdomain: "cafe-alefba",
  cloudOrigin: "https://app.example.com",
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desktop-identity-shell-"));
  dirs.push(dir);
  return dir;
}

/** Write the same document shape src/lib/desktop-identity-file.ts publishes. */
function writeIdentity(file: string, instanceId: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      format: "bizamiz-desktop-business-identity",
      version: 1,
      instanceFingerprint: identityFile.instanceFingerprint(instanceId),
      ...IDENTITY,
      publishedAt: "2026-11-25T00:00:00.000Z",
      ...overrides,
    }),
  );
}

function registryWith(overrides: Partial<RegistryProfile> = {}): Registry {
  const profile = registryModule.createProfile({
    id: PROFILE_ID,
    displayName: "کافه الفبا",
    ...overrides,
  });
  return {
    format: "bizamiz-desktop-business-profiles",
    schemaVersion: 1,
    lastUsedProfileId: PROFILE_ID,
    profiles: [profile],
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("backend-published business identity", () => {
  it("points at the profile's own Configuration directory", () => {
    const root = tempDir();
    expect(identityFile.businessIdentityPath(root)).toBe(
      path.join(root, "Configuration", "business-identity.json"),
    );
  });

  it("agrees with the server's fingerprint construction", () => {
    expect(identityFile.instanceFingerprint("instance-1")).toBe(serverInstanceFingerprint("instance-1"));
    expect(identityFile.instanceFingerprint("  instance-1  ")).toBe(serverInstanceFingerprint("instance-1"));
  });

  it("accepts the document its own backend wrote", () => {
    const file = path.join(tempDir(), "Configuration", "business-identity.json");
    writeIdentity(file, "instance-1");
    const read = identityFile.readBusinessIdentityFile(file, identityFile.instanceFingerprint("instance-1"));
    expect(read.state).toBe("ok");
    expect(read.identity).toEqual(IDENTITY);
  });

  it("refuses a well-formed document copied from another profile's backend", () => {
    const file = path.join(tempDir(), "Configuration", "business-identity.json");
    writeIdentity(file, "another-profile-instance");
    const read = identityFile.readBusinessIdentityFile(file, identityFile.instanceFingerprint("instance-1"));
    expect(read).toMatchObject({ state: "foreign", identity: null });
  });

  it("refuses a document whose tenant conflicts with the saved profile", () => {
    const file = path.join(tempDir(), "Configuration", "business-identity.json");
    writeIdentity(file, "instance-1");
    const read = identityFile.readBusinessIdentityFile(file, identityFile.instanceFingerprint("instance-1"));
    const registry = registryWith({ businessId: OTHER_PROFILE_ID });

    const result = registryModule.recordProfileIdentity(registry, PROFILE_ID, read.identity);
    expect(result).toMatchObject({ ok: false, error: "identity_conflict", field: "businessId" });
    // Nothing was written: the original registry object is returned untouched.
    expect(result.registry).toBeUndefined();
    expect(registry.profiles[0].businessId).toBe(OTHER_PROFILE_ID);
  });

  it("fills an unnamed profile from its own backend's document", () => {
    const file = path.join(tempDir(), "Configuration", "business-identity.json");
    writeIdentity(file, "instance-1");
    const read = identityFile.readBusinessIdentityFile(file, identityFile.instanceFingerprint("instance-1"));
    const registry = registryWith();

    const result = registryModule.recordProfileIdentity(registry, PROFILE_ID, read.identity);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.registry?.profiles[0]).toMatchObject(IDENTITY);
  });

  it("refuses malformed or credential-shaped documents", () => {
    const file = path.join(tempDir(), "Configuration", "business-identity.json");
    const fingerprint = identityFile.instanceFingerprint("instance-1");
    const cases: Array<Record<string, unknown>> = [
      { format: "something-else" },
      { version: 2 },
      { businessId: "not-a-uuid" },
      { cloudOrigin: "http://app.example.com" },
      { publishedAt: "" },
      { password: "hunter2" },
      { extra: "value" },
    ];
    for (const overrides of cases) {
      writeIdentity(file, "instance-1", overrides);
      expect(identityFile.readBusinessIdentityFile(file, fingerprint), JSON.stringify(overrides)).toMatchObject({
        state: "invalid",
        identity: null,
      });
    }
  });

  it("reports a missing file without inventing an identity", () => {
    const file = path.join(tempDir(), "Configuration", "business-identity.json");
    expect(identityFile.readBusinessIdentityFile(file, identityFile.instanceFingerprint("instance-1"))).toMatchObject({
      state: "missing",
      identity: null,
    });
  });

  it("has no renderer-facing identity channel left to abuse", () => {
    // The trust boundary this file exists for: the renderer must not be able to
    // report a tenant id at all. If an IPC channel or preload method reappears,
    // this test fails before a page script can name a saved business.
    for (const relativePath of ["electron/main.js", "electron/preload.js"]) {
      const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
      expect(source).not.toContain("desktop:business-identity");
      expect(source).not.toContain("recordIdentity");
    }
  });

  it("fails closed when the profile's instance id is unavailable", () => {
    const file = path.join(tempDir(), "Configuration", "business-identity.json");
    writeIdentity(file, "instance-1");
    expect(identityFile.readBusinessIdentityFile(file, null)).toMatchObject({
      state: "invalid",
      identity: null,
    });
  });
});
