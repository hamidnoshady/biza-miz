#!/usr/bin/env node
// Issue #1000 - real Windows verification of the Desktop updater's security
// contract. This runs the packaged engine against a *real signed* installer and
// the Windows Authenticode provider (it refuses to run anywhere else), proving
// what a unit test cannot: the exact subject/CN and the exact certificate
// thumbprint that Windows reports, and rejection of tampered or mis-pinned
// installers.
//
// It is deliberately read-only with respect to the installed application: no
// installer is executed and no release is published.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DesktopUpdateEngine, canonicalManifestPayload } = require("../electron/update-engine.js");
const { launchStagedInstaller } = require("../electron/installer-staging.js");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const installerPath = path.resolve(argument("installer", ""));
const expectedSigner = argument("signer") || process.env.WINDOWS_EXPECTED_SIGNER || "";
const expectedThumbprint = (argument("thumbprint") || process.env.WINDOWS_EXPECTED_SIGNER_THUMBPRINT || "")
  .replace(/[\s:]/g, "")
  .toUpperCase();
const outputPath = path.resolve(argument("output", "windows-updater-verification.json"));

const failures = [];
function record(id, error) {
  if (!error) return;
  failures.push({ id, error: error?.code || error?.message || String(error) });
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const installerBytes = readFileSync(installerPath);
const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");
const installerSize = statSync(installerPath).size;

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const roots = [];
function temporaryDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "windows-updater-verification-"));
  roots.push(root);
  return root;
}

function manifest(overrides = {}) {
  const value = {
    manifestSignature: "",
    version: "9.9.9",
    buildCommit: "a".repeat(40),
    buildId: "windows-updater-verification",
    channel: "stable",
    releasedAt: "2026-01-01T00:00:00.000Z",
    minimumSupportedVersion: "0.0.1",
    mandatory: false,
    installer: {
      url: "https://github.com/example/updater-verification/setup.exe",
      sha256: installerSha256,
      size: installerSize,
      signatureRequired: true,
      expectedPublisher: expectedSigner,
      expectedPublisherThumbprint: expectedThumbprint,
    },
    database: { migrationVersion: 1, minimumSchemaVersion: 1, maximumSchemaVersion: 9999, backupRequired: true },
    releaseNotes: ["windows updater verification"],
    recovery: { knownGoodVersion: null, notes: null },
  };
  const merged = { ...value, ...overrides, installer: { ...value.installer, ...(overrides.installer ?? {}) } };
  merged.manifestSignature = sign("sha256", Buffer.from(canonicalManifestPayload(merged)), keys.privateKey).toString("base64");
  return merged;
}

function engineFor(extra = {}) {
  const root = temporaryDir();
  return new DesktopUpdateEngine({
    app: { getPath: () => root, getVersion: () => "0.0.1" },
    logger: { warn: (...args) => console.warn(...args), info: () => undefined },
    expectedPublisher: expectedSigner,
    manifestPublicKey: publicKeyPem,
    ...extra,
  });
}

function writeManifest(value, name) {
  const root = temporaryDir();
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

async function offline(updater, value, name, installer = installerPath) {
  return updater.prepareOffline(writeManifest(value, name), installer);
}

function expectState(state, expected, id) {
  if (state.state !== expected.state || (expected.errorCode && state.errorCode !== expected.errorCode)) {
    record(id, `${expected.state}/${expected.errorCode ?? "-"} expected, got ${state.state}/${state.errorCode ?? "-"}`);
  } else {
    console.log(`PASS ${id}: ${state.state}/${state.errorCode ?? "-"}`);
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.error("This verification requires Windows: it exercises the real Authenticode provider.");
    process.exit(2);
  }
  if (!expectedSigner || !/^[0-9A-F]{40}$/.test(expectedThumbprint)) {
    console.error("--signer and a 40-character --thumbprint (or their environment variables) are required");
    process.exit(2);
  }

  // 1. Real Authenticode, exact subject/CN and exact thumbprint.
  const validEngine = engineFor();
  expectState(await offline(validEngine, manifest(), "valid"), { state: "ready_to_install" }, "authenticode-exact-pin");

  // 2. A different, same-named certificate is refused.
  const wrongThumbprint = "B".repeat(40);
  expectState(
    await offline(engineFor(), manifest({ installer: { expectedPublisherThumbprint: wrongThumbprint } }), "wrong-thumbprint"),
    { state: "failed", errorCode: "authenticode_invalid" },
    "wrong-thumbprint",
  );

  // 3. A matching thumbprint cannot rescue a wrong publisher name.
  expectState(
    await offline(engineFor(), manifest({ installer: { expectedPublisher: "Updater Verification Impostor" } }), "wrong-subject"),
    { state: "failed", errorCode: "authenticode_invalid" },
    "wrong-subject",
  );

  // 4. A missing pin is a refusal, not a fallback to the name check.
  const missingPin = manifest();
  delete missingPin.installer.expectedPublisherThumbprint;
  missingPin.manifestSignature = sign("sha256", Buffer.from(canonicalManifestPayload(missingPin)), keys.privateKey).toString("base64");
  expectState(
    await offline(engineFor(), missingPin, "missing-pin"),
    { state: "failed", errorCode: "expected_publisher_thumbprint_missing" },
    "missing-thumbprint",
  );

  // 5. A manifest changed after it was signed never reaches a download.
  const tamperedManifest = manifest();
  tamperedManifest.installer.sha256 = "c".repeat(64);
  expectState(
    await offline(engineFor(), tamperedManifest, "tampered-manifest"),
    { state: "failed", errorCode: "manifest_signature_invalid" },
    "manifest-signature",
  );

  // 6. Modified installer bytes fail the hash before any signature check.
  const tamperedInstaller = path.join(temporaryDir(), "tampered-installer.exe");
  copyFileSync(installerPath, tamperedInstaller);
  const tamperedBytes = readFileSync(tamperedInstaller);
  tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
  writeFileSync(tamperedInstaller, tamperedBytes);
  expectState(
    await offline(engineFor(), manifest(), "tampered-installer", tamperedInstaller),
    { state: "failed", errorCode: "installer_sha256_mismatch" },
    "tampered-installer",
  );

  // 7. Staging copies the verified bytes; a swapped staged file is refused
  //    before any process is started.
  const stagingEngine = engineFor();
  expectState(await offline(stagingEngine, manifest(), "staging"), { state: "ready_to_install" }, "staging-ready");
  try {
    const staged = await stagingEngine.stageVerifiedInstaller();
    const stagedBytes = readFileSync(staged.path);
    stagedBytes[stagedBytes.length - 1] ^= 0xff;
    writeFileSync(staged.path, stagedBytes);
    await launchStagedInstaller({
      staged,
      installDirectory: temporaryDir(),
      sha256: installerSha256,
    });
    record("staged-installer-swap", "a modified staged installer was not refused");
  } catch (error) {
    if (!/installer_(sha256_mismatch|replaced_after_verification)/.test(String(error?.code))) {
      record("staged-installer-swap", error);
    } else {
      console.log(`PASS staged-installer-swap: ${error.code}`);
    }
  }

  const report = {
    schemaVersion: 1,
    platform: process.platform,
    installerSha256,
    installerSize,
    expectedSigner,
    expectedThumbprint,
    checks: [
      "authenticode-exact-pin",
      "wrong-thumbprint",
      "wrong-subject",
      "missing-thumbprint",
      "manifest-signature",
      "tampered-installer",
      "staging-ready",
      "staged-installer-swap",
    ],
    failures,
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (!report.ok) {
    console.error(`Windows updater verification failed: ${JSON.stringify(failures)}`);
    process.exit(1);
  }
  console.log(`Windows updater verification passed (installer ${installerSha256}).`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
