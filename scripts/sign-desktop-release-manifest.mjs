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

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: sign-desktop-release-manifest.mjs <manifest.json>");
const privatePem = process.env.DESKTOP_RELEASE_PRIVATE_KEY_PEM?.replaceAll("\\n", "\n").trim();
if (!privatePem) throw new Error("DESKTOP_RELEASE_PRIVATE_KEY_PEM is required");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const bytes = Buffer.from(canonicalPayload(manifest));
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
