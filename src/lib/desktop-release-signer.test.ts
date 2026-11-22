import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The signer has to pin timestamps to the exact form Central can give back.
 *
 * `released_at`/`manifest_expires_at` are `timestamptz`, and both the Desktop
 * and Central canonicalize the string they are handed. PowerShell's
 * `[DateTime]::ToString('o')` emits seven fractional digits; the database and
 * `Date#toISOString` return three. A manifest signed before that truncation can
 * therefore never verify after the round trip — which is exactly what happened
 * to the first schema-2 release: it was valid as published and invalid as soon
 * as Central normalized `releasedAt`.
 */
const script = join(process.cwd(), "scripts", "sign-desktop-release-manifest.mjs");

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function manifest() {
  return {
    schemaVersion: 2,
    appId: "bizamiz-desktop",
    version: "1.0.299",
    releaseSequence: 1000299,
    buildCommit: "abcdef1234567890",
    buildId: "build-run-test",
    channel: "stable",
    platform: "win32",
    architecture: "x64",
    // Deliberately the PowerShell spelling: seven fractional digits.
    releasedAt: "2026-11-22T07:26:49.7145064Z",
    expiresAt: "2027-05-21T07:26:49.7145064Z",
    minimumSupportedVersion: "1.0.218",
    mandatory: false,
    installer: {
      url: "https://github.com/example/product/releases/download/desktop-v1.0.299/Setup.exe",
      sha256: "a".repeat(64),
      size: 180017677,
      signatureRequired: false,
    },
    database: {
      migrationVersion: 311,
      minimumSchemaVersion: 1,
      maximumSchemaVersion: 311,
      backupRequired: true,
    },
    releaseNotes: ["test"],
    recovery: { knownGoodVersion: null, notes: "test" },
    signatureAlgorithm: "ed25519",
    signingKeyId: "",
  };
}

describe("sign-desktop-release-manifest", () => {
  it("pins timestamps to milliseconds so the signature survives Central's round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-release-signer-"));
    const file = join(dir, "release-manifest.json");
    writeFileSync(file, JSON.stringify(manifest(), null, 2));

    execFileSync(process.execPath, [script, file], {
      env: { ...process.env, DESKTOP_RELEASE_ED25519_PRIVATE_KEY_PEM: privateKey },
      stdio: "pipe",
    });

    const signed = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;

    expect(signed.releasedAt).toBe("2026-11-22T07:26:49.714Z");
    expect(signed.expiresAt).toBe("2027-05-21T07:26:49.714Z");
    expect(signed.signingKeyId).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The published bytes verify against the pinned public key...
    expect(() =>
      execFileSync(process.execPath, [script, "--verify", file], {
        env: { ...process.env, DESKTOP_RELEASE_ED25519_PUBLIC_KEY_PEM: publicKey },
        stdio: "pipe",
      }),
    ).not.toThrow();

    // ...and re-serializing the timestamps cannot move the canonical payload,
    // which is the invariant the database round trip depends on.
    expect(new Date(signed.releasedAt).toISOString()).toBe(signed.releasedAt);
    expect(new Date(signed.expiresAt).toISOString()).toBe(signed.expiresAt);
  });
});
