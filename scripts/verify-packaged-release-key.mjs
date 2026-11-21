#!/usr/bin/env node
// Proves that a packaged Desktop carries the release verification keys the
// updater trusts. electron/desktop-release-public-key.pem and
// electron/desktop-release-keys.json are placeholders in Git; a package built
// without the embed step fails closed at manifest verification, so every
// distributable build must be checked before it can become a release.
//
// Usage: node scripts/verify-packaged-release-key.mjs <app.asar> [expected.pem] [expected-keys.json]
// Set REQUIRE_REAL_RELEASE_KEY=1 to fail when no real trust anchor shipped.
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const [asarPath, expectedPemPath, expectedKeysPath] = process.argv.slice(2);
if (!asarPath) throw new Error("Usage: verify-packaged-release-key.mjs <app.asar> [expected.pem] [expected-keys.json]");

function readAsarEntry(archive, name) {
  // The Pickle header length at offset 12 is not the JSON length (it excludes
  // the pickle prefix), so find the closing brace and take the data offset
  // from the size field at offset 4, exactly as Electron's asar reader does.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonEnd = -1;
  for (let index = 16; index < archive.length; index += 1) {
    const byte = archive[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) inString = false;
      continue;
    }
    if (byte === 34) inString = true;
    else if (byte === 123) depth += 1;
    else if (byte === 125) {
      depth -= 1;
      if (depth === 0) { jsonEnd = index + 1; break; }
    }
  }
  if (jsonEnd < 0) throw new Error(`Invalid asar header in ${asarPath}`);
  const header = JSON.parse(archive.subarray(16, jsonEnd).toString("utf8"));
  const entry = header.files?.[name];
  if (!entry || entry.files) return null;
  if (entry.unpacked) throw new Error(`${name} is unpacked; read it from app.asar.unpacked`);
  const dataStart = 8 + archive.readUInt32LE(4);
  const start = dataStart + Number(entry.offset);
  return archive.subarray(start, start + entry.size);
}

const derOf = (pem) => createPublicKey(pem).export({ type: "spki", format: "der" });
const idOf = (pem) => `sha256:${createHash("sha256").update(derOf(pem)).digest("hex")}`;

function parseKeyring(text) {
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!parsed || !Array.isArray(parsed.keys)) return [];
  return parsed.keys.filter((entry) => entry && typeof entry.id === "string" &&
    typeof entry.publicKeyPem === "string" && ["ed25519", "rsa-sha256"].includes(entry.algorithm));
}

const archive = readFileSync(asarPath);
const legacyPem = (readAsarEntry(archive, "desktop-release-public-key.pem") ?? Buffer.alloc(0)).toString("utf8").trim();
const keyringText = (readAsarEntry(archive, "desktop-release-keys.json") ?? Buffer.alloc(0)).toString("utf8").trim();
const keyring = parseKeyring(keyringText);

const problems = [];
let legacyDer = null;
if (legacyPem) {
  try { legacyDer = derOf(legacyPem); } catch { problems.push("legacy public key is malformed"); }
}
for (const entry of keyring) {
  try {
    const pem = entry.publicKeyPem.replaceAll("\\n", "\n");
    const der = derOf(pem);
    const expectedId = `sha256:${createHash("sha256").update(der).digest("hex")}`;
    if (entry.id !== expectedId) problems.push(`keyring entry ${entry.id} does not match its public key ${expectedId}`);
    if (entry.algorithm === "ed25519" && createPublicKey(pem).asymmetricKeyType !== "ed25519") {
      problems.push(`keyring entry ${entry.id} is not Ed25519`);
    }
    if (entry.algorithm === "rsa-sha256" && !String(createPublicKey(pem).asymmetricKeyType).startsWith("rsa")) {
      problems.push(`keyring entry ${entry.id} is not RSA`);
    }
  } catch {
    problems.push(`keyring entry ${entry.id} cannot be parsed`);
  }
}
if (problems.length) throw new Error(`Packaged release keyring is invalid: ${problems.join("; ")}`);

const hasTrustAnchor = Boolean(legacyDer) || keyring.length > 0;
if (!hasTrustAnchor) {
  const message = "Packaged app.asar embeds no real release trust anchor (placeholder key and empty keyring); the updater can never verify a manifest.";
  if (process.env.REQUIRE_REAL_RELEASE_KEY === "1") throw new Error(message);
  console.warn(`::warning title=Release key not embedded::${message}`);
  process.exit(0);
}

if (expectedPemPath) {
  const expected = readFileSync(expectedPemPath, "utf8").trim();
  let expectedDer = null;
  try { expectedDer = derOf(expected); } catch { /* checkout still holds the placeholder */ }
  if (expectedDer && legacyDer && !expectedDer.equals(legacyDer)) {
    throw new Error("Packaged legacy release public key does not match electron/desktop-release-public-key.pem");
  }
}
if (expectedKeysPath) {
  const expected = parseKeyring(readFileSync(expectedKeysPath, "utf8"));
  const packagedIds = new Set(keyring.map((entry) => entry.id));
  for (const entry of expected) {
    if (!packagedIds.has(entry.id)) throw new Error(`Packaged keyring is missing ${entry.id}`);
    const packaged = keyring.find((item) => item.id === entry.id);
    if (!derOf(packaged.publicKeyPem.replaceAll("\\n", "\n")).equals(derOf(entry.publicKeyPem.replaceAll("\\n", "\n")))) {
      throw new Error(`Packaged keyring entry ${entry.id} does not match the checkout key`);
    }
  }
}

console.log(`Packaged release trust anchors: legacy=${Boolean(legacyDer)} keyring=${keyring.length}`);
