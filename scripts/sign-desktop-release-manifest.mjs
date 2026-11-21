#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function canonicalPayloadV1(manifest) {
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

function canonicalPayloadV2(manifest) {
  return JSON.stringify({
    schemaVersion: 2,
    appId: manifest.appId,
    version: manifest.version,
    releaseSequence: manifest.releaseSequence,
    buildCommit: manifest.buildCommit,
    buildId: manifest.buildId,
    channel: manifest.channel,
    platform: manifest.platform,
    architecture: manifest.architecture,
    releasedAt: manifest.releasedAt,
    expiresAt: manifest.expiresAt ?? null,
    minimumSupportedVersion: manifest.minimumSupportedVersion,
    mandatory: manifest.mandatory,
    installer: {
      url: manifest.installer.url,
      sha256: manifest.installer.sha256,
      size: manifest.installer.size,
      signatureRequired: manifest.installer.signatureRequired === true,
      ...(manifest.installer.signatureRequired === true ? {
        expectedPublisher: manifest.installer.expectedPublisher ?? null,
        expectedPublisherThumbprint: manifest.installer.expectedPublisherThumbprint ?? null,
      } : {}),
    },
    database: {
      migrationVersion: manifest.database.migrationVersion,
      minimumSchemaVersion: manifest.database.minimumSchemaVersion,
      maximumSchemaVersion: manifest.database.maximumSchemaVersion,
      backupRequired: manifest.database.backupRequired,
    },
    releaseNotes: manifest.releaseNotes,
    recovery: {
      knownGoodVersion: manifest.recovery?.knownGoodVersion ?? null,
      notes: manifest.recovery?.notes ?? null,
    },
    signatureAlgorithm: manifest.signatureAlgorithm,
    signingKeyId: manifest.signingKeyId,
  });
}

function canonicalPayload(manifest) {
  return (manifest.schemaVersion ?? 1) >= 2 ? canonicalPayloadV2(manifest) : canonicalPayloadV1(manifest);
}

function algorithmOf(manifest) {
  if ((manifest.schemaVersion ?? 1) < 2) return "rsa-sha256";
  if (manifest.signatureAlgorithm !== "ed25519" && manifest.signatureAlgorithm !== "rsa-sha256") {
    throw new Error("A schema 2 manifest must name signatureAlgorithm: ed25519 or rsa-sha256");
  }
  return manifest.signatureAlgorithm;
}

function publicKeyId(publicKey) {
  return `sha256:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
}

function envPem(name) {
  return process.env[name]?.replaceAll("\\n", "\n").trim() ?? "";
}

function configuredPublicKey(manifest, algorithm) {
  const inline = envPem(algorithm === "ed25519" ? "DESKTOP_RELEASE_ED25519_PUBLIC_KEY_PEM" : "DESKTOP_RELEASE_PUBLIC_KEY_PEM");
  if (inline) return createPublicKey(inline);
  const keyring = envPem("DESKTOP_RELEASE_KEYS_JSON");
  if (keyring) {
    const parsed = JSON.parse(keyring.replace(/^\uFEFF/, ""));
    const entry = Array.isArray(parsed?.keys)
      ? parsed.keys.find((item) => item?.id === manifest.signingKeyId && item?.algorithm === algorithm)
      : null;
    if (entry?.publicKeyPem) return createPublicKey(String(entry.publicKeyPem).replaceAll("\\n", "\n"));
  }
  return null;
}

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify");
const manifestPath = args.find((arg) => arg !== "--verify");
if (!manifestPath) throw new Error("Usage: sign-desktop-release-manifest.mjs [--verify] <manifest.json>");
const manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
const algorithm = algorithmOf(manifest);

// Issue #1000 - the production pipeline reads the manifest back from the
// published release and verifies it against the same public key the Desktop
// embeds, so an unsigned or truncated upload cannot be registered in Central.
if (verifyOnly) {
  const publicKey = configuredPublicKey(manifest, algorithm);
  if (!publicKey) throw new Error("A release public key is required to verify a manifest");
  const bytes = Buffer.from(canonicalPayload(manifest));
  const signature = typeof manifest.manifestSignature === "string" ? Buffer.from(manifest.manifestSignature, "base64") : null;
  const valid = signature && (algorithm === "ed25519"
    ? verify(null, bytes, publicKey, signature)
    : verify("sha256", bytes, publicKey, signature));
  if (!valid) throw new Error("The release manifest signature is not valid for the configured public key");
  if ((manifest.schemaVersion ?? 1) >= 2) {
    const expectedId = publicKeyId(publicKey);
    if (manifest.signingKeyId !== expectedId) {
      throw new Error(`Manifest signingKeyId ${manifest.signingKeyId} does not identify the verification key ${expectedId}`);
    }
  }
  console.log(`Verified ${manifestPath} against the configured release public key (${algorithm})`);
  process.exit(0);
}

const privatePem = envPem(algorithm === "ed25519" ? "DESKTOP_RELEASE_ED25519_PRIVATE_KEY_PEM" : "DESKTOP_RELEASE_PRIVATE_KEY_PEM");
if (!privatePem) {
  throw new Error(algorithm === "ed25519"
    ? "DESKTOP_RELEASE_ED25519_PRIVATE_KEY_PEM is required"
    : "DESKTOP_RELEASE_PRIVATE_KEY_PEM is required");
}
const privateKey = createPrivateKey(privatePem);
if (algorithm === "ed25519" && privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("DESKTOP_RELEASE_ED25519_PRIVATE_KEY_PEM must be an Ed25519 key");
}
if (algorithm === "rsa-sha256" && privateKey.asymmetricKeyType !== "rsa" && privateKey.asymmetricKeyType !== "rsa-pss") {
  throw new Error("DESKTOP_RELEASE_PRIVATE_KEY_PEM must be an RSA key");
}

// A schema 2 manifest names its key. Derive and pin that id from the private
// key's public half so the manifest can never claim a key that did not sign it.
if ((manifest.schemaVersion ?? 1) >= 2) {
  const derivedId = publicKeyId(createPublicKey(privateKey));
  if (manifest.signingKeyId === undefined || manifest.signingKeyId === null || manifest.signingKeyId === "") {
    manifest.signingKeyId = derivedId;
  }
  if (manifest.signingKeyId !== derivedId) {
    throw new Error(`Manifest signingKeyId ${manifest.signingKeyId} does not match the signing key ${derivedId}`);
  }
}

const bytes = Buffer.from(canonicalPayload(manifest));
manifest.manifestSignature = (algorithm === "ed25519"
  ? sign(null, bytes, privateKey)
  : sign("sha256", bytes, privateKey)).toString("base64");

const publicPem = envPem(algorithm === "ed25519" ? "DESKTOP_RELEASE_ED25519_PUBLIC_KEY_PEM" : "DESKTOP_RELEASE_PUBLIC_KEY_PEM");
if (publicPem) {
  const publicKey = createPublicKey(publicPem);
  const valid = algorithm === "ed25519"
    ? verify(null, bytes, publicKey, Buffer.from(manifest.manifestSignature, "base64"))
    : verify("sha256", bytes, publicKey, Buffer.from(manifest.manifestSignature, "base64"));
  if (!valid) throw new Error("The configured release public and private keys do not match");
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Signed ${manifestPath} with ${algorithm}`);
