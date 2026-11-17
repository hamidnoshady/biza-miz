#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function canonicalPayload(manifest) {
  return JSON.stringify({
    version: manifest.version,
    buildCommit: manifest.buildCommit,
    buildId: manifest.buildId,
    channel: manifest.channel,
    minimumSupportedVersion: manifest.minimumSupportedVersion,
    mandatory: manifest.mandatory,
    installer: {
      url: manifest.installer.url,
      sha256: manifest.installer.sha256,
      size: manifest.installer.size,
      signatureRequired: manifest.installer.signatureRequired,
      expectedPublisher: manifest.installer.expectedPublisher,
      ...(manifest.installer.expectedPublisherThumbprint
        ? { expectedPublisherThumbprint: manifest.installer.expectedPublisherThumbprint }
        : {}),
    },
    database: {
      migrationVersion: manifest.database.migrationVersion,
      minimumSchemaVersion: manifest.database.minimumSchemaVersion,
      maximumSchemaVersion: manifest.database.maximumSchemaVersion,
      backupRequired: manifest.database.backupRequired,
    },
    releaseNotes: manifest.releaseNotes,
  });
}

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify");
const manifestPath = args.find((arg) => arg !== "--verify");
if (!manifestPath) throw new Error("Usage: sign-desktop-release-manifest.mjs [--verify] <manifest.json>");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const bytes = Buffer.from(canonicalPayload(manifest));

// Issue #1000 - the production pipeline reads the manifest back from the
// published release and verifies it against the same public key the Desktop
// embeds, so an unsigned or truncated upload cannot be registered in Central.
if (verifyOnly) {
  const verifyPem = process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n").trim();
  if (!verifyPem) throw new Error("DESKTOP_RELEASE_PUBLIC_KEY_PEM is required to verify a release manifest");
  const signature = typeof manifest.manifestSignature === "string" ? Buffer.from(manifest.manifestSignature, "base64") : null;
  if (!signature || !verify("sha256", bytes, createPublicKey(verifyPem), signature)) {
    throw new Error("The release manifest signature is not valid for the configured public key");
  }
  console.log(`Verified ${manifestPath} against the configured release public key`);
  process.exit(0);
}

const privatePem = process.env.DESKTOP_RELEASE_PRIVATE_KEY_PEM?.replaceAll("\\n", "\n").trim();
if (!privatePem) throw new Error("DESKTOP_RELEASE_PRIVATE_KEY_PEM is required");
const privateKey = createPrivateKey(privatePem);
if (privateKey.asymmetricKeyType !== "rsa" && privateKey.asymmetricKeyType !== "rsa-pss") {
  throw new Error("DESKTOP_RELEASE_PRIVATE_KEY_PEM must be an RSA key");
}
manifest.manifestSignature = sign("sha256", bytes, privateKey).toString("base64");

const publicPem = process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n").trim();
if (publicPem && !verify("sha256", bytes, createPublicKey(publicPem), Buffer.from(manifest.manifestSignature, "base64"))) {
  throw new Error("The configured release public and private keys do not match");
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Signed ${manifestPath} with RSA-SHA256`);
