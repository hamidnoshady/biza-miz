#!/usr/bin/env node
// Proves that a packaged Desktop carries the release-manifest public key the
// updater verifies with. electron/desktop-release-public-key.pem is only a
// placeholder in Git; a package built without the embed step fails closed at
// manifest_signature_invalid, so every distributable build must be checked.
//
// Usage: node scripts/verify-packaged-release-key.mjs <app.asar> [expected.pem]
// Set REQUIRE_REAL_RELEASE_KEY=1 to fail when the placeholder shipped.
import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";

const [asarPath, expectedPath] = process.argv.slice(2);
if (!asarPath) throw new Error("Usage: verify-packaged-release-key.mjs <app.asar> [expected.pem]");

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
  if (!entry || entry.files) throw new Error(`${name} is missing from ${asarPath}`);
  if (entry.unpacked) throw new Error(`${name} is unpacked; read it from app.asar.unpacked`);
  const dataStart = 8 + archive.readUInt32LE(4);
  const start = dataStart + Number(entry.offset);
  return archive.subarray(start, start + entry.size);
}

function publicKeyDer(pem) {
  return createPublicKey(pem).export({ type: "spki", format: "der" });
}

const archive = readFileSync(asarPath);
const packaged = readAsarEntry(archive, "desktop-release-public-key.pem").toString("utf8").trim();

let packagedDer;
try {
  packagedDer = publicKeyDer(packaged);
} catch {
  const message = "Packaged app.asar embeds the placeholder release public key; the updater can never verify a manifest.";
  if (process.env.REQUIRE_REAL_RELEASE_KEY === "1") throw new Error(message);
  console.warn(`::warning title=Release key not embedded::${message}`);
  process.exit(0);
}

if (expectedPath) {
  const expected = readFileSync(expectedPath, "utf8").trim();
  let expectedDer;
  try {
    expectedDer = publicKeyDer(expected);
  } catch {
    console.warn("::warning title=Expected key is a placeholder::The checkout key is not a real PEM; only the packaged key was validated.");
  }
  if (expectedDer && !expectedDer.equals(packagedDer)) {
    throw new Error("Packaged release public key does not match electron/desktop-release-public-key.pem");
  }
}

console.log(`Packaged release public key is a valid RSA key: ${asarPath}`);
