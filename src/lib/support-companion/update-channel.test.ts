import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalRecipeJson } from "./repair-catalog";
import {
  buildUpdateManifest,
  canonicalUpdateJson,
  isSafeChannelName,
  isSystemVersion,
  signUpdateManifest,
  verifyUpdateManifest,
} from "./update-channel";

describe("canonicalUpdateJson", () => {
  it("byte-matches canonicalRecipeJson (the C# CanonicalJson spec) on fixtures", () => {
    const fixtures: unknown[] = [
      { channel: "companion-stable", version: "1.2.0", kid: "release-1", files: [] },
      {
        kid: "release-1",
        files: [
          { path: "BizaSupportCompanion.exe", bytes: 123456789, sha256: "a".repeat(64) },
          { path: "notes/ß.txt", bytes: 0, sha256: "b".repeat(64) },
        ],
        version: "1.2.0",
        channel: "companion-stable",
      },
      { nested: { z: [3, 2, { b: null, a: true }], a: "ünïcodé ✓" }, empty: {} },
    ];
    for (const fixture of fixtures) {
      expect(canonicalUpdateJson(fixture)).toBe(canonicalRecipeJson(fixture));
    }
    // And the canonical form is actually canonical: key order + spacing in.
    expect(canonicalUpdateJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });
});

describe("buildUpdateManifest", () => {
  const file = { path: "BizaSupportCompanion.exe", bytes: 123456789, sha256: "a".repeat(64) };

  it("builds a channel manifest whose canonical bytes are the served bytes", () => {
    const built = buildUpdateManifest({
      channel: "companion-stable",
      version: "1.2.0",
      kid: "release-1",
      files: [file],
    });
    expect(built.canonical).toBe(
      '{"channel":"companion-stable","files":[{"bytes":123456789,"path":"BizaSupportCompanion.exe","sha256":"' +
        "a".repeat(64) +
        '"}],"kid":"release-1","version":"1.2.0"}',
    );
    expect(JSON.parse(built.canonical)).toEqual(built.manifest);
  });

  it("refuses everything the companion verifier would refuse", () => {
    const good = { channel: "companion-stable", version: "1.2.0", kid: "release-1", files: [file] };
    expect(() => buildUpdateManifest({ ...good, channel: "../evil" })).toThrow("unsafe channel name");
    expect(() => buildUpdateManifest({ ...good, version: "1.2.3.4.5" })).toThrow("System.Version");
    expect(() => buildUpdateManifest({ ...good, version: "v1.2" })).toThrow("System.Version");
    expect(() => buildUpdateManifest({ ...good, kid: "  " })).toThrow("kid");
    expect(() => buildUpdateManifest({ ...good, files: [] })).toThrow("no files");
    expect(() =>
      buildUpdateManifest({ ...good, files: [{ ...file, path: "../x.exe" }] }),
    ).toThrow("unsafe file path");
    expect(() =>
      buildUpdateManifest({ ...good, files: [{ ...file, sha256: "A".repeat(64) }] }),
    ).toThrow("lowercase hex");
    expect(() => buildUpdateManifest({ ...good, files: [{ ...file, bytes: -1 }] })).toThrow(
      "non-negative integer",
    );
  });

  it("validates versions and channel names", () => {
    for (const version of ["1", "1.2", "1.2.3", "1.2.3.4", "0.0.0.0", "2147483647.0"]) {
      expect(isSystemVersion(version)).toBe(true);
    }
    for (const version of ["", "v1", "1.2.3.4.5", "1.0-beta", "2147483648.0", "1..2"]) {
      expect(isSystemVersion(version)).toBe(false);
    }
    expect(isSafeChannelName("companion-stable")).toBe(true);
    expect(isSafeChannelName("a")).toBe(true);
    for (const channel of ["", "-x", "a/b", "a b", "x".repeat(65)]) {
      expect(isSafeChannelName(channel)).toBe(false);
    }
  });
});

describe("signUpdateManifest", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
  const canonical = '{"channel":"companion-stable","kid":"release-1","version":"1.2.0"}';

  it("round-trips: sign → verify, and any byte drift fails", () => {
    const sig = signUpdateManifest(canonical, privatePem);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyUpdateManifest(canonical, sig, publicPem)).toBe(true);
    expect(verifyUpdateManifest(`${canonical} `, sig, publicPem)).toBe(false);
    expect(verifyUpdateManifest(canonical, `${sig.slice(0, -2)}AA`, publicPem)).toBe(false);
    expect(verifyUpdateManifest(canonical, sig, "not a key")).toBe(false);
  });

  it("refuses non-RSA keys and empty keys", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecPem = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => signUpdateManifest(canonical, ecPem)).toThrow("must be RSA");
    expect(() => signUpdateManifest(canonical, "  ")).toThrow("empty");
  });
});
