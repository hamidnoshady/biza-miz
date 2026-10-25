import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The packaged engine is CommonJS because Electron loads it directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DesktopUpdateEngine, canonicalManifestPayload, compareSemVer, safeManifest } = require("../../electron/update-engine.js") as {
  DesktopUpdateEngine: new (input: Record<string, unknown>) => {
    check(value: unknown): { state: string; errorCode: string | null };
    checkPersistedTarget(): { state: string; errorCode: string | null };
    publicState(): { state: string; backupPath?: string | null };
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
