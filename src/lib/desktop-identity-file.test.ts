/**
 * #1572 follow-up — the backend's own identity publication.
 *
 * The important properties here are the ones that replaced the old
 * renderer-reported hand-off: nothing is written outside a desktop runtime,
 * an unprovable identity is refused as a whole, and the document is bound to
 * this profile's backend by a one-way instance fingerprint (never the instance
 * secret itself).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUSINESS_IDENTITY_FORMAT,
  BUSINESS_IDENTITY_VERSION,
  buildDesktopIdentityDocument,
  desktopIdentityFilePath,
  instanceFingerprint,
  publishDesktopBusinessIdentity,
} from "./desktop-identity-file";

const IDENTITY = {
  businessId: "11111111-1111-4111-8111-111111111111",
  businessSubdomain: "cafe-alefba",
  cloudOrigin: "https://app.example.com",
};

const dirs: string[] = [];
function tempFile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "desktop-identity-"));
  dirs.push(root);
  return path.join(root, "Configuration", "business-identity.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("desktop identity file", () => {
  it("is a no-op when the runtime is not a desktop backend", () => {
    const result = publishDesktopBusinessIdentity(IDENTITY, { env: {} });
    expect(result).toEqual({ ok: false, path: null, error: "not_desktop" });
  });

  it("refuses a relative identity path rather than writing somewhere else", () => {
    expect(desktopIdentityFilePath({ DESKTOP_IDENTITY_PATH: "Configuration/business-identity.json" })).toBeNull();
  });

  it("binds the document to this profile's backend with a one-way fingerprint", () => {
    const document = buildDesktopIdentityDocument(IDENTITY, { DESKTOP_INSTANCE_ID: "instance-1" });
    expect(document).toMatchObject({
      format: BUSINESS_IDENTITY_FORMAT,
      version: BUSINESS_IDENTITY_VERSION,
      businessId: IDENTITY.businessId,
      businessSubdomain: IDENTITY.businessSubdomain,
      cloudOrigin: IDENTITY.cloudOrigin,
    });
    expect(document?.instanceFingerprint).toBe(instanceFingerprint("instance-1"));
    // The instance secret itself must never appear in the plaintext document.
    expect(JSON.stringify(document)).not.toContain("instance-1");
  });

  it("writes the validated document exactly where the shell looks for it", () => {
    const file = tempFile();
    const result = publishDesktopBusinessIdentity(IDENTITY, {
      env: { DESKTOP_IDENTITY_PATH: file, DESKTOP_INSTANCE_ID: "instance-1" },
    });
    expect(result).toEqual({ ok: true, path: file });
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([
      "businessId",
      "businessSubdomain",
      "cloudOrigin",
      "format",
      "instanceFingerprint",
      "publishedAt",
      "version",
    ]);
    expect(written.instanceFingerprint).toBe(instanceFingerprint("instance-1"));
  });

  it("accepts a locally created business that has no Cloud origin yet", () => {
    const file = tempFile();
    const result = publishDesktopBusinessIdentity(
      { ...IDENTITY, cloudOrigin: null, businessSubdomain: null },
      { env: { DESKTOP_IDENTITY_PATH: file, DESKTOP_INSTANCE_ID: "instance-1" } },
    );
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(written.cloudOrigin).toBeNull();
    expect(written.businessSubdomain).toBeNull();
  });

  it("refuses an identity it cannot prove, and writes nothing", () => {
    const file = tempFile();
    const env = { DESKTOP_IDENTITY_PATH: file, DESKTOP_INSTANCE_ID: "instance-1" };
    for (const identity of [
      { ...IDENTITY, businessId: "not-a-uuid" },
      { ...IDENTITY, businessSubdomain: "not a subdomain" },
      { ...IDENTITY, cloudOrigin: "http://app.example.com" },
      { ...IDENTITY, cloudOrigin: "https://app.example.com/dashboard" },
    ]) {
      expect(publishDesktopBusinessIdentity(identity, { env })).toMatchObject({
        ok: false,
        error: "invalid_identity",
      });
    }
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to publish without the instance id that proves the profile", () => {
    const file = tempFile();
    expect(
      publishDesktopBusinessIdentity(IDENTITY, { env: { DESKTOP_IDENTITY_PATH: file } }),
    ).toMatchObject({ ok: false, error: "invalid_identity" });
    expect(existsSync(file)).toBe(false);
  });
});
