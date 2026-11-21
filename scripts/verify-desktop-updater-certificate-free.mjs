#!/usr/bin/env node
// Proves the certificate-free updater against a real installer file on Windows.
// It uses a throwaway Ed25519 key, so no protected production key is involved.
// It never executes the installer: it verifies the manifest, size, SHA-256 and
// the optional-Authenticode path exactly as the packaged engine does.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DesktopUpdateEngine, canonicalManifestPayload } = require("../electron/update-engine.js");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const installerPath = arg("installer");
const outputPath = arg("output") || "windows-certificate-free-updater-verification.json";
if (!installerPath || !fs.existsSync(installerPath)) throw new Error("--installer must name an existing file");

const installer = fs.readFileSync(installerPath);
const sha256 = createHash("sha256").update(installer).digest("hex");
const keys = generateKeyPairSync("ed25519");
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const keyId = `sha256:${createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
const keyring = { schemaVersion: 1, keys: [{ id: keyId, algorithm: "ed25519", publicKeyPem: publicPem, notBefore: null, notAfter: null, revoked: false }] };
const roots = [];

function manifest(overrides = {}) {
  const value = {
    schemaVersion: 2,
    appId: "bizamiz-desktop",
    version: "9.9.9",
    releaseSequence: 9999,
    buildCommit: "a".repeat(40),
    buildId: "certificate-free-verification",
    channel: "stable",
    platform: "win32",
    architecture: process.arch,
    releasedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    minimumSupportedVersion: "1.0.0",
    mandatory: false,
    installer: { url: "https://github.com/example/release.exe", sha256, size: installer.length, signatureRequired: false },
    database: { migrationVersion: 311, minimumSchemaVersion: 1, maximumSchemaVersion: 311, backupRequired: true },
    releaseNotes: ["certificate-free verification"],
    recovery: { knownGoodVersion: null, notes: null },
    signatureAlgorithm: "ed25519",
    signingKeyId: keyId,
    manifestSignature: "",
    ...overrides,
  };
  value.manifestSignature = sign(null, Buffer.from(canonicalManifestPayload(value)), keys.privateKey).toString("base64");
  return value;
}

function engine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "certificate-free-updater-"));
  roots.push(root);
  return new DesktopUpdateEngine({
    app: { getPath: () => root, getVersion: () => "1.0.0", isPackaged: false },
    logger: { warn: () => undefined, info: () => undefined },
    manifestKeyring: keyring,
    platform: "win32",
    architecture: process.arch,
  });
}

const results = [];
async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail ?? null });
  } catch (error) {
    results.push({ name, ok: false, error: error?.code || String(error?.message || error) });
  }
}

await check("accepts the signed certificate-free manifest", () => {
  const state = engine().check(manifest());
  if (state.state !== "update_available") throw Object.assign(new Error(state.errorCode || state.state), { code: state.errorCode || state.state });
  return state.state;
});
await check("verifies the real installer size and SHA-256 without Authenticode", async () => {
  await engine().verifyInstallerBytes(installerPath, manifest());
  return { bytes: installer.length, sha256 };
});
await check("rejects a tampered manifest hash", () => {
  const tampered = manifest({ version: "9.9.10", releaseSequence: 10000 });
  tampered.installer.sha256 = "b".repeat(64);
  const state = engine().check(tampered);
  if (state.state !== "failed" || state.errorCode !== "manifest_signature_invalid") {
    throw Object.assign(new Error(state.errorCode || state.state), { code: state.errorCode || state.state });
  }
  return state.errorCode;
});
await check("rejects tampered installer bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "certificate-free-tampered-"));
  roots.push(root);
  const tamperedPath = path.join(root, "tampered.exe");
  const bytes = Buffer.from(installer);
  bytes[Math.max(0, bytes.length - 1)] ^= 0xff;
  fs.writeFileSync(tamperedPath, bytes);
  try {
    await engine().verifyInstallerBytes(tamperedPath, manifest());
    throw new Error("tampered installer was accepted");
  } catch (error) {
    if (error?.code !== "installer_sha256_mismatch") throw error;
    return error.code;
  }
});
await check("still enforces Authenticode when the manifest asks for it", async () => {
  const signedManifest = manifest({
    installer: {
      url: "https://github.com/example/release.exe",
      sha256,
      size: installer.length,
      signatureRequired: true,
      expectedPublisher: "Bizamiz Verification",
      expectedPublisherThumbprint: "A".repeat(40),
    },
  });
  try {
    await engine().verifyInstallerBytes(installerPath, signedManifest);
    throw new Error("unsigned installer passed a signatureRequired manifest");
  } catch (error) {
    if (!["authenticode_invalid", "authenticode_windows_required"].includes(error?.code)) throw error;
    return error.code;
  }
});

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  installer: { name: path.basename(installerPath), bytes: installer.length, sha256 },
  keyId,
  results,
  ok: results.every((entry) => entry.ok),
};
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
if (!evidence.ok) {
  console.error(JSON.stringify(evidence, null, 2));
  process.exit(1);
}
console.log(`Certificate-free updater verification passed (${results.length} checks) for ${evidence.installer.name}`);
