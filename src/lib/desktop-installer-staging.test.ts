/**
 * Issue #1000 - secure installer staging. These tests run the real
 * electron/installer-staging.js (no Electron needed) and cover what can be
 * proven on a POSIX host: the protected copy, reparse-point refusal, the
 * identity re-check between verification and launch, pruning, and the Windows
 * launcher's lock-and-rehash design. The Windows handle lock itself can only be
 * exercised by the signed-candidate workflow on a real Windows runner.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const staging = require("../../electron/installer-staging.js") as {
  launchStagedInstaller(input: Record<string, unknown>): Promise<{ installerPid: number | null; locked: boolean }>;
  lockedLaunchScript(): string;
  lockDownStagingDirectory(directory: string, options?: Record<string, unknown>): Promise<{ applied: boolean }>;
  pruneStagedInstallers(updatesDir: string, keepPath?: string): string[];
  stageInstaller(input: Record<string, unknown>): Promise<{ path: string; identity: Record<string, unknown>; aclApplied: boolean }>;
  stagingDirectory(updatesDir: string): string;
  assertStagedUnchanged(staged: unknown): fs.Stats;
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-installer-staging-"));
  roots.push(root);
  return root;
}

function writeInstaller(root: string, bytes = Buffer.alloc(64, 7)): string {
  const file = path.join(root, "downloaded-installer.exe");
  fs.writeFileSync(file, bytes);
  return file;
}

async function stage(root: string, sourcePath: string, expectedSize?: number) {
  return staging.stageInstaller({
    sourcePath,
    updatesDir: root,
    version: "1.2.3",
    expectedSize: expectedSize ?? fs.statSync(sourcePath).size,
  });
}

describe("installer staging folder", () => {
  it("copies the download into a restricted folder with a fresh name", async () => {
    const root = temporaryRoot();
    const source = writeInstaller(root);
    const staged = await stage(root, source);

    expect(staged.path).not.toBe(source);
    expect(path.dirname(staged.path)).toBe(staging.stagingDirectory(root));
    expect(path.basename(staged.path)).toMatch(/^Bizamiz-1\.2\.3-[0-9a-f-]{36}\.exe$/);
    expect(fs.readFileSync(staged.path).equals(fs.readFileSync(source))).toBe(true);
    // POSIX modes are the measurable half here; the ACL is Windows-only.
    expect(fs.statSync(staging.stagingDirectory(root)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(staged.path).mode & 0o777).toBe(0o600);
    expect(staged.identity).toMatchObject({ size: 64 });
    expect(() => staging.assertStagedUnchanged(staged)).not.toThrow();
  });

  it("refuses a symlink or reparse point instead of hashing whatever it points at", async () => {
    const root = temporaryRoot();
    const real = writeInstaller(root);
    const link = path.join(root, "link-installer.exe");
    fs.symlinkSync(real, link);

    await expect(stage(root, link)).rejects.toThrow("installer_reparse_point");
    // A staged file turned into a link is refused by the identity check.
    const staged = await stage(root, real);
    const replacement = path.join(root, "replacement.exe");
    fs.writeFileSync(replacement, Buffer.alloc(64, 9));
    fs.rmSync(staged.path);
    fs.symlinkSync(replacement, staged.path);
    expect(() => staging.assertStagedUnchanged(staged)).toThrow("installer_reparse_point");
  });

  it("refuses a download whose size is not the manifest size", async () => {
    const root = temporaryRoot();
    const source = writeInstaller(root, Buffer.alloc(32));
    await expect(stage(root, source, 64)).rejects.toThrow("installer_size_mismatch");
    expect(fs.existsSync(staging.stagingDirectory(root))
      ? fs.readdirSync(staging.stagingDirectory(root)).length
      : 0).toBe(0);
  });

  it("detects a staged installer whose identity changed after it was verified", async () => {
    const root = temporaryRoot();
    const source = writeInstaller(root);
    const staged = await stage(root, source);

    fs.appendFileSync(staged.path, Buffer.from([1]));
    expect(() => staging.assertStagedUnchanged(staged)).toThrow("installer_replaced_after_verification");
  });

  it("never launches a staged file whose bytes changed before the launch", async () => {
    const root = temporaryRoot();
    const source = writeInstaller(root);
    const staged = await stage(root, source);
    // Same size, different bytes: only re-hashing the open handle can prove it.
    fs.writeFileSync(staged.path, Buffer.alloc(64, 5));

    await expect(staging.launchStagedInstaller({
      staged,
      installDirectory: root,
      sha256: (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
    })).rejects.toThrow(/installer_(replaced_after_verification|sha256_mismatch)/);
  });

  it("refuses to launch when the staged path no longer exists", async () => {
    const root = temporaryRoot();
    const source = writeInstaller(root);
    const staged = await stage(root, source);
    fs.rmSync(staged.path);
    await expect(staging.launchStagedInstaller({
      staged,
      installDirectory: root,
      sha256: "a".repeat(64),
    })).rejects.toThrow("installer_missing");
  });

  it("keeps only the newest staged installers", async () => {
    const root = temporaryRoot();
    const source = writeInstaller(root);
    const staged = [];
    for (let index = 0; index < 5; index += 1) staged.push(await stage(root, source));
    // Distinct ages: staged[0] oldest … staged[3] newest; staged[4] is "now".
    staged.slice(0, 4).forEach((entry, index) => {
      const stamp = new Date(2026, 0, 1, 0, 0, index);
      fs.utimesSync(entry.path, stamp, stamp);
    });

    // Retention keeps the newest two plus the one about to be launched.
    const removed = staging.pruneStagedInstallers(root, staged[4].path);
    expect(removed.sort()).toEqual(staged.slice(0, 2).map((entry) => entry.path).sort());
    expect(fs.readdirSync(staging.stagingDirectory(root)).sort())
      .toEqual(staged.slice(2).map((entry) => path.basename(entry.path)).sort());
  });

  it("treats a non-Windows host as 'no ACL applied' rather than claiming one", async () => {
    const root = temporaryRoot();
    const result = await staging.lockDownStagingDirectory(path.join(root, "staging"));
    expect(result.applied).toBe(false);
    expect(fs.statSync(path.join(root, "staging")).mode & 0o777).toBe(0o700);
  });

  it("locks the staged file against writes and re-hashes it before starting it", () => {
    const script = staging.lockedLaunchScript();
    // The handle denies write/delete/rename; the hash is computed from it.
    expect(script).toContain("[IO.FileShare]::Read");
    expect(script).not.toContain("[IO.FileShare]::ReadWrite");
    expect(script).toContain("ComputeHash");
    expect(script).toContain("staged_installer_hash_mismatch");
    expect(script.indexOf("ComputeHash")).toBeLessThan(script.indexOf("Start-Process"));
  });
});
