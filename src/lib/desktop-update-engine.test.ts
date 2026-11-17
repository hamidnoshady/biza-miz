import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The packaged engine is CommonJS because Electron loads it directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DesktopUpdateEngine, canonicalManifestPayload, compareSemVer, safeManifest, publisherMatchesCertificate, certificateMatchesPin } = require("../../electron/update-engine.js") as {
  DesktopUpdateEngine: new (input: Record<string, unknown>) => {
    check(value: unknown): { state: string; errorCode: string | null };
    checkPersistedTarget(): { state: string; errorCode: string | null };
    publicState(): { state: string; backupPath?: string | null };
    dir: string;
    download(): Promise<unknown>;
    launchInstaller(): Promise<{ state: string }>;
    stageVerifiedInstaller(): Promise<{ path: string; identity: Record<string, unknown> }>;
    on(event: string, listener: (state: { state: string }) => void): void;
    targetPath: string;
    backupDir: string;
    state: { target: unknown; installerPath: string | null; backupPath: string | null };
    pgTool(name: string): string;
    prunePreUpdateBackups(preservePath?: string): string[];
    createVerifiedBackup(backend: unknown): Promise<string>;
  };
  canonicalManifestPayload(value: unknown): string;
  compareSemVer(left: string, right: string): -1 | 0 | 1 | null;
  safeManifest(value: unknown): Record<string, unknown>;
  publisherMatchesCertificate(certificate: unknown, expectedPublisher: string): boolean;
  certificateMatchesPin(certificate: unknown, expectedPublisher: string, expectedThumbprint: string): boolean;
};

const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function manifest(overrides: Record<string, unknown> = {}) {
  const value = {
    manifestSignature: "",
    version: "1.1.0",
    buildCommit: "6f714578",
    buildId: "production-1",
    channel: "stable",
    releasedAt: "2026-09-28T08:00:00.000Z",
    minimumSupportedVersion: "1.0.0",
    mandatory: false,
    installer: {
      url: "https://github.com/example/project/releases/download/v1.1.0/update.exe",
      sha256: "a".repeat(64), size: 1024, signatureRequired: true, expectedPublisher: "Business Suite",
      expectedPublisherThumbprint: "A".repeat(40),
    },
    database: { migrationVersion: 187, minimumSchemaVersion: 150, maximumSchemaVersion: 187, backupRequired: true },
    releaseNotes: ["Safe update"], recovery: { knownGoodVersion: "1.0.5", notes: null },
    ...overrides,
  };
  value.manifestSignature = crypto.sign("sha256", Buffer.from(canonicalManifestPayload(value)), keys.privateKey).toString("base64");
  return value;
}

function engine(version = "1.0.5", extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-engine-")); roots.push(root);
  return new DesktopUpdateEngine({
    app: { getPath: () => root, getVersion: () => version },
    logger: { warn: () => undefined, info: () => undefined },
    expectedPublisher: "Business Suite",
    manifestPublicKey: publicKey,
    ...extra,
  });
}

describe("packaged Desktop Update Engine", () => {
  it("uses SemVer ordering including prereleases", () => {
    expect(compareSemVer("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemVer("1.1.0-beta.2", "1.1.0-beta.10")).toBe(-1);
    expect(compareSemVer("git-sha", "1.1.0")).toBeNull();
  });

  it("requires HTTPS, signing, hashes and backup policy in every manifest", () => {
    expect(safeManifest(manifest())).toMatchObject({ version: "1.1.0" });
    expect(() => safeManifest(manifest({ database: { backupRequired: false } }))).toThrow("manifest_backup_required");
    expect(() => safeManifest(manifest({ installer: { ...(manifest().installer as object), signatureRequired: false } }))).toThrow("manifest_signature_required");
  });

  it("requires a well-formed certificate thumbprint pin in every manifest", () => {
    const installer = () => manifest().installer as Record<string, unknown>;
    expect(() => safeManifest(manifest({ installer: { ...installer(), expectedPublisherThumbprint: "" } })))
      .toThrow("expected_publisher_thumbprint_missing");
    expect(() => safeManifest(manifest({ installer: { ...installer(), expectedPublisherThumbprint: "not-a-thumbprint" } })))
      .toThrow("expected_publisher_thumbprint_invalid");
    expect(() => safeManifest(manifest({ installer: { ...installer(), expectedPublisherThumbprint: "a".repeat(39) } })))
      .toThrow("expected_publisher_thumbprint_invalid");
    expect(safeManifest(manifest())).toMatchObject({ installer: { expectedPublisherThumbprint: "A".repeat(40) } });
  });

  it("requires both the exact publisher and the exact certificate thumbprint", () => {
    const certificate = {
      status: "Valid",
      subject: "CN=Business Suite LLC, O=Bizamiz, C=IR",
      simpleName: "Business Suite LLC",
      thumbprint: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    };
    expect(certificateMatchesPin(certificate, "Business Suite LLC", "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678")).toBe(true);
    expect(certificateMatchesPin(certificate, "Business Suite LLC", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe(true);
    // A different certificate with the same publisher name is refused.
    expect(certificateMatchesPin(certificate, "Business Suite LLC", "B1B2C3D4E5F60718293A4B5C6D7E8F9012345678")).toBe(false);
    // A matching thumbprint cannot rescue a wrong publisher.
    expect(certificateMatchesPin(certificate, "Business Suite", "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678")).toBe(false);
    expect(certificateMatchesPin({ ...certificate, thumbprint: null }, "Business Suite LLC", "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678")).toBe(false);
    expect(certificateMatchesPin(certificate, "Business Suite LLC", "")).toBe(false);
  });

  it("stages the verified copy and removes it when the copy does not verify", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-stage-")); roots.push(root);
    const updater = engine("1.0.5");
    fs.writeFileSync(path.join(root, "installer.exe"), Buffer.alloc(1024));
    updater.state.target = manifest();
    updater.state.installerPath = path.join(root, "installer.exe");
    await expect(updater.stageVerifiedInstaller()).rejects.toThrow("installer_sha256_mismatch");
    const stagingDir = path.join(updater.dir, "staging");
    expect(fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : []).toEqual([]);
  });

  it("refuses to stage from a symlinked download", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-link-")); roots.push(root);
    const updater = engine("1.0.5");
    const real = path.join(root, "installer.exe");
    fs.writeFileSync(real, Buffer.alloc(1024));
    const link = path.join(root, "link.exe");
    fs.symlinkSync(real, link);
    updater.state.target = manifest();
    updater.state.installerPath = link;
    await expect(updater.stageVerifiedInstaller()).rejects.toThrow("installer_reparse_point");
  });

  it("rejects a manifest changed after release signing", () => {
    const signed = manifest();
    signed.version = "9.9.9";
    const result = engine().check(signed);
    expect(result.state).toBe("failed");
    expect(result.errorCode).toBe("manifest_signature_invalid");
  });

  it("checks the backend-persisted target while the settings renderer is closed", () => {
    const updater = engine();
    fs.writeFileSync(updater.targetPath, JSON.stringify(manifest()));
    expect(updater.checkPersistedTarget().state).toBe("update_available");
  });

  it("rejects arbitrary installer origins before download", () => {
    const result = engine().check(manifest({ installer: { ...(manifest().installer as object), url: "https://evil.invalid/update.exe" } }));
    expect(result.state).toBe("failed");
    expect(result.errorCode).toBe("installer_origin_not_allowed");
  });

  it("rejects downgrades and exposes a real update only for newer targets", () => {
    expect(engine("1.2.0").check(manifest()).state).toBe("no_update");
    expect(engine("1.0.5").check(manifest()).state).toBe("update_available");
  });

  it("requires scratch verification and keeps the superuser password out of pg_dump arguments", async () => {
    let args: string[] = [];
    let childEnv: Record<string, string | undefined> = {};
    const verified: string[] = [];
    const updater = engine("1.0.5", {
      commandRunner: async (_executable: string, argv: string[], options: { env: Record<string, string | undefined> }) => {
        args = argv;
        childEnv = options.env;
        const output = argv.find((value) => value.startsWith("--file="))?.slice("--file=".length);
        if (!output) throw new Error("missing dump output");
        fs.writeFileSync(output, Buffer.alloc(2048));
        return { stdout: "", stderr: "" };
      },
    });
    updater.pgTool = () => "/fake/pg_dump";
    updater.state.target = { version: "1.1.0" };
    updater.state.installerPath = "installer.exe";
    const backup = await updater.createVerifiedBackup({
      config: { pgPassword: "superuser-secret", pgPort: 5544 },
      preUpdateSafety: async () => ({ openShifts: 0, openOrders: 0 }),
      verifyPreUpdateBackup: async (file: string) => {
        verified.push(file);
        return { verified: { migrations: 10, tables: [{ name: "orders", rows: 1 }] } };
      },
    });
    expect(verified).toEqual([backup]);
    expect(args.join(" ")).not.toContain("superuser-secret");
    expect(childEnv.PGPASSWORD).toBe("superuser-secret");
    expect(updater.publicState().backupPath).toBe(backup);
  });

  it("pins the publisher to an exact subject or common name, never a substring", () => {
    const certificate = {
      status: "Valid",
      subject: "CN=Business Suite LLC, O=Bizamiz, C=IR",
      simpleName: "Business Suite LLC",
    };
    expect(publisherMatchesCertificate(certificate, "CN=Business Suite LLC, O=Bizamiz, C=IR")).toBe(true);
    expect(publisherMatchesCertificate(certificate, "Business Suite LLC")).toBe(true);
    expect(publisherMatchesCertificate(certificate, "business suite llc")).toBe(true);
    // The previous PowerShell `-notlike '*publisher*'` accepted all of these.
    expect(publisherMatchesCertificate(certificate, "Business Suite")).toBe(false);
    expect(publisherMatchesCertificate(certificate, "Business")).toBe(false);
    expect(publisherMatchesCertificate(certificate, "Suite LLC")).toBe(false);
    expect(publisherMatchesCertificate(certificate, "CN=Business Suite LLC, O=Bizamiz, C=IR, OU=Test")).toBe(false);
    expect(publisherMatchesCertificate(certificate, "%")).toBe(false);
    expect(publisherMatchesCertificate(certificate, "")).toBe(false);
    expect(publisherMatchesCertificate({ status: "Valid", subject: null, simpleName: null }, "Business Suite LLC")).toBe(false);
  });

  it("re-verifies the installer bytes immediately before launching it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-launch-")); roots.push(root);
    const updater = engine("1.0.5");
    const installer = path.join(root, "installer.exe");
    fs.writeFileSync(installer, Buffer.alloc(512));
    updater.state.target = manifest();
    updater.state.installerPath = installer;
    // The download-time size check is repeated here, after the file sat in a
    // user-writable folder, so a swapped or truncated installer never runs.
    await expect(updater.launchInstaller()).rejects.toThrow("installer_size_mismatch");
    expect(updater.publicState().state).not.toBe("installing");

    fs.writeFileSync(installer, Buffer.alloc(1024));
    await expect(updater.launchInstaller()).rejects.toThrow("installer_sha256_mismatch");
    expect(updater.publicState().state).not.toBe("installing");
  });

  it("throttles download progress writes instead of persisting every chunk", async () => {
    const updater = engine("1.0.5");
    updater.state.target = manifest();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: (async function* () { for (let index = 0; index < 1024; index += 1) yield Buffer.alloc(1, 1); })(),
    })) as unknown as typeof fetch;
    let downloading = 0;
    updater.on("state", (state: { state: string }) => { if (state.state === "downloading") downloading += 1; });
    try {
      await updater.download();
    } catch {
      // The fixture manifest's hash is not this stream; only the loop matters.
    } finally {
      globalThis.fetch = original;
    }
    expect(downloading).toBeGreaterThanOrEqual(1);
    expect(downloading).toBeLessThan(20);
  });

  it("prunes old pre-update dumps only within the retention set", () => {
    const updater = engine();
    const files = Array.from({ length: 7 }, (_, index) => {
      const file = path.join(updater.backupDir, `pre-update-${index}.dump`);
      fs.writeFileSync(file, "dump");
      const stamp = new Date(2026, 0, index + 1);
      fs.utimesSync(file, stamp, stamp);
      return file;
    });
    const unrelated = path.join(updater.backupDir, "notes.txt");
    fs.writeFileSync(unrelated, "keep");
    const removed = updater.prunePreUpdateBackups(files[6]);
    expect(removed.sort()).toEqual([files[0], files[1]].sort());
    expect(fs.readdirSync(updater.backupDir).filter((name) => name.endsWith(".dump"))).toHaveLength(5);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
