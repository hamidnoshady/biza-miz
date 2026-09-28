import { execFile } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDesktopManifestPayload, validateDesktopReleaseManifest } from "./desktop-release";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("release manifest signing", () => {
  it("produces a signature compatible with the canonical Central and Electron payload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "release-signing-")); roots.push(root);
    const file = path.join(root, "release-manifest.json");
    const manifest = {
      schemaVersion: 1,
      version: "2.3.0", buildCommit: "a".repeat(40), buildId: "candidate-123", channel: "stable",
      releasedAt: "2026-09-28T08:00:00.000Z", minimumSupportedVersion: "1.0.0", mandatory: false,
      installer: {
        url: "https://github.com/example/product/releases/download/desktop-v2.3.0/setup.exe",
        sha256: "b".repeat(64), size: 12345, signatureRequired: true, expectedPublisher: "Business Suite",
      },
      database: { migrationVersion: 187, minimumSchemaVersion: 1, maximumSchemaVersion: 187, backupRequired: true },
      releaseNotes: ["Verified release"], recovery: { knownGoodVersion: null, notes: null },
    };
    await writeFile(file, JSON.stringify(manifest));
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    await exec(process.execPath, ["scripts/sign-desktop-release-manifest.mjs", file], {
      cwd: process.cwd(),
      env: { ...process.env, DESKTOP_RELEASE_PRIVATE_KEY_PEM: privatePem, DESKTOP_RELEASE_PUBLIC_KEY_PEM: publicPem },
    });
    const signed = JSON.parse(await readFile(file, "utf8"));
    const validated = validateDesktopReleaseManifest(signed);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(verify(
      "sha256",
      Buffer.from(canonicalDesktopManifestPayload(validated.manifest)),
      keys.publicKey,
      Buffer.from(validated.manifest.manifestSignature, "base64"),
    )).toBe(true);
  });
});
