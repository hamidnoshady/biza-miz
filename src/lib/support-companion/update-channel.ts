/**
 * Issue #984 — companion update-channel manifest builder/signer (server side).
 *
 * The companion's Updates tab trusts one thing: an RSA-PKCS#1v1.5+SHA256
 * signature over the *canonical* manifest JSON, verified against the
 * machine-provisioned `update-keys.json` bundle (`UpdateManifest.cs`).
 * This module builds those manifests so no operator ever hand-writes a
 * sha256/bytes pair: `scripts/build-companion-update.mts` is the CLI,
 * and these are its pure, unit-tested cores.
 *
 * The release RSA key is deliberately the SAME key as the #981 desktop
 * channel (`DESKTOP_RELEASE_PRIVATE_KEY_PEM`): one release authority,
 * two channels, each with its own canonical form and signature file.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export interface UpdateChannelFile {
  /** Relative, install-dir-rooted, `/`-separated — the verifier refuses anything else. */
  path: string;
  bytes: number;
  /** Lowercase hex sha256 of the exact bytes served at base URL + path. */
  sha256: string;
}

export interface UpdateChannelManifest {
  channel: string;
  /** `System.Version`-compatible: 1–4 dot-separated non-negative integers. */
  version: string;
  /** Key id — must name an entry in the companion's approved-keys bundle. */
  kid: string;
  files: UpdateChannelFile[];
}

/**
 * Canonical JSON: sorted keys, recursive, no whitespace — byte-identical
 * to `canonicalRecipeJson` (repair-catalog.ts) and the companion's
 * `CanonicalJson` (same spec: ordinal key order, `JSON.stringify`
 * scalars). Kept local (not imported) so this module stays free of the
 * database client; `update-channel.test.ts` pins byte-equality between
 * the two implementations on fixtures.
 */
export function canonicalUpdateJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalUpdateJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalUpdateJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** `System.Version.TryParse` accepts 1–4 numeric components; each fits int32. */
export function isSystemVersion(version: string): boolean {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((part) => /^\d{1,10}$/.test(part) && Number(part) <= 2_147_483_647);
}

/**
 * Channel names become file names (`<channel>.json` + `.sig`) on a static
 * host and match the companion's configured channel exactly.
 */
export function isSafeChannelName(channel: string): boolean {
  return channel.length >= 1 && channel.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(channel);
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length >= 1 &&
    path.length <= 260 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("..") &&
    !path.includes(":") &&
    /^[ -~]+$/.test(path)
  );
}

export interface BuiltUpdateManifest {
  manifest: UpdateChannelManifest;
  /** The exact bytes to serve as `<channel>.json` — and to sign. */
  canonical: string;
}

/**
 * Builds + validates a manifest. Throws `Error` with the precise reason
 * on anything the companion's verifier would refuse, so a bad channel
 * fails at build time, never on a customer's machine.
 */
export function buildUpdateManifest(input: {
  channel: string;
  version: string;
  kid: string;
  files: UpdateChannelFile[];
}): BuiltUpdateManifest {
  const { channel, version, kid, files } = input;
  if (!isSafeChannelName(channel)) {
    throw new Error(`unsafe channel name: ${JSON.stringify(channel)}`);
  }
  if (!isSystemVersion(version)) {
    throw new Error(`version is not System.Version-compatible: ${JSON.stringify(version)}`);
  }
  if (!kid.trim()) {
    throw new Error("kid must name the release key in the companion's approved-keys bundle");
  }
  if (files.length === 0) {
    throw new Error("manifest names no files");
  }
  if (files.length > 5_000) {
    throw new Error("manifest names too many files");
  }
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`unsafe file path: ${JSON.stringify(file.path)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`sha256 for ${JSON.stringify(file.path)} is not lowercase hex`);
    }
    if (!Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`bytes for ${JSON.stringify(file.path)} is not a non-negative integer`);
    }
  }
  const manifest: UpdateChannelManifest = { channel, version, kid: kid.trim(), files };
  const canonical = canonicalUpdateJson(manifest);
  if (Buffer.byteLength(canonical, "utf8") > 256 * 1024) {
    throw new Error("manifest exceeds the companion's 256 KiB cap");
  }
  return { manifest, canonical };
}

/**
 * Signs canonical manifest bytes with the release RSA key (PKCS#1 v1.5 +
 * SHA-256, the same primitive as the #981 desktop signer) and returns the
 * base64url signature text for `<channel>.json.sig`. Refuses non-RSA keys,
 * and self-verifies against the derived public key before returning, so a
 * corrupted key fails here instead of shipping an uninstallable channel.
 */
export function signUpdateManifest(canonical: string, privatePem: string): string {
  const pem = privatePem.replaceAll("\\n", "\n").trim();
  if (!pem) {
    throw new Error("release private key is empty");
  }
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "rsa" && privateKey.asymmetricKeyType !== "rsa-pss") {
    throw new Error("release private key must be RSA");
  }
  const signature = sign("sha256", Buffer.from(canonical, "utf8"), privateKey);
  const publicKey = createPublicKey(privateKey);
  if (!verify("sha256", Buffer.from(canonical, "utf8"), publicKey, signature)) {
    throw new Error("self-verification failed: the release key pair is inconsistent");
  }
  return signature.toString("base64url");
}

/**
 * Verifies a channel signature against a PEM public key — the script's
 * round-trip check and the operator's offline audit primitive. Mirrors
 * the companion verifier's inputs (canonical bytes + base64url RSA sig).
 */
export function verifyUpdateManifest(canonical: string, signatureBase64Url: string, publicPem: string): boolean {
  try {
    return verify(
      "sha256",
      Buffer.from(canonical, "utf8"),
      createPublicKey(publicPem.replaceAll("\\n", "\n").trim()),
      Buffer.from(signatureBase64Url.trim(), "base64url"),
    );
  } catch {
    return false;
  }
}
