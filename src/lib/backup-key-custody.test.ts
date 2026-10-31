import { describe, expect, it } from "vitest";
import {
  custodySummary,
  generateArtifactSecret,
  openArtifactKey,
  openPortableRecoveryEnvelope,
  planKeyRotation,
  sameSecret,
  sealArtifactKey,
  sealPortableRecoveryEnvelope,
  selectCustodyKey,
  type ArtifactKeyRecord,
} from "./backup-key-custody";

const KEY = Buffer.alloc(32, 3);
const OTHER_KEY = Buffer.alloc(32, 4);
const BUSINESS = "biz-a";
const OTHER_BUSINESS = "biz-b";

function sealed(version = 1, businessId = BUSINESS, masterKey = KEY) {
  return sealArtifactKey(masterKey, { businessId, version, now: new Date("2026-10-01T00:00:00Z") });
}

describe("artifact key sealing", () => {
  it("round-trips the generated secret", () => {
    const { secret, record } = sealed();
    const opened = openArtifactKey(KEY, record);
    expect(opened).toEqual({ ok: true, secret });
    expect(secret).toBe(generateArtifactSecret() && secret);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(record.status).toBe("active");
    expect(record.version).toBe(1);
  });

  it("never stores the secret in the record", () => {
    const { secret, record } = sealed();
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain(secret);
    expect(record.wrapped).not.toBe("");
  });

  it("fails closed with a different master key", () => {
    const { record } = sealed();
    expect(openArtifactKey(OTHER_KEY, record)).toEqual({ ok: false, error: "backup_key_mismatch" });
  });

  it("binds the wrapped key to its business and version", () => {
    const { record } = sealed();
    expect(openArtifactKey(KEY, { ...record, businessId: OTHER_BUSINESS })).toEqual({
      ok: false,
      error: "backup_key_mismatch",
    });
    // Relabelling the version must not decrypt either.
    expect(openArtifactKey(KEY, { ...record, version: 2 })).toEqual({ ok: false, error: "backup_key_mismatch" });
    expect(
      openArtifactKey(KEY, record, { businessId: OTHER_BUSINESS, version: record.version }),
    ).toEqual({ ok: false, error: "backup_key_mismatch" });
  });

  it("refuses a revoked key rather than silently decrypting old artifacts", () => {
    const { record } = sealed();
    expect(openArtifactKey(KEY, { ...record, status: "revoked" })).toEqual({
      ok: false,
      error: "backup_key_revoked",
    });
  });

  it("treats a truncated record as unreadable, not as a wrong key", () => {
    const { record } = sealed();
    expect(openArtifactKey(KEY, { ...record, nonce: Buffer.alloc(4).toString("base64") })).toEqual({
      ok: false,
      error: "backup_key_unreadable",
    });
    expect(openArtifactKey(KEY, { ...record, tag: Buffer.alloc(2).toString("base64") })).toEqual({
      ok: false,
      error: "backup_key_unreadable",
    });
  });
});

describe("custody selection and rotation", () => {
  function record(version: number, status: ArtifactKeyRecord["status"]): ArtifactKeyRecord {
    return {
      ...sealed(version).record,
      status,
      retiredAt: status === "retired" ? "2026-10-02T00:00:00Z" : null,
    };
  }

  it("selects the highest active version and reports missing/revoked custody", () => {
    expect(selectCustodyKey([record(1, "retired"), record(2, "active"), record(3, "retired")])).toMatchObject({
      ok: true,
      record: { version: 2 },
    });
    expect(selectCustodyKey([])).toEqual({ ok: false, error: "backup_key_missing" });
    expect(selectCustodyKey([record(1, "revoked")])).toEqual({ ok: false, error: "backup_key_revoked" });
  });

  it("plans rotation forward without renumbering or reviving keys", () => {
    const plan = planKeyRotation([record(1, "retired"), record(2, "revoked"), record(3, "active")]);
    expect(plan.nextVersion).toBe(4);
    expect(plan.retained).toEqual([1, 3]);
    expect(plan.blocked).toEqual([2]);
  });

  it("summarises custody for the operator console", () => {
    const summary = custodySummary([record(1, "retired"), record(2, "active")], {
      kekAvailable: true,
      legacyArtifacts: true,
    });
    expect(summary.scheme).toBe("managed_envelope_v1");
    expect(summary.activeVersion).toBe(2);
    expect(summary.legacyArtifacts).toBe(true);
    expect(summary.versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(JSON.stringify(summary)).not.toContain("wrapped");
  });

  it("reports unconfigured — never plaintext — when the platform has no key", () => {
    expect(custodySummary([], { kekAvailable: false })).toMatchObject({ scheme: "unconfigured", activeVersion: null });
    expect(custodySummary([], { kekAvailable: true, legacyArtifacts: true }).scheme).toBe("legacy_passphrase_v1");
  });
});

describe("portable recovery envelope", () => {
  const passphrase = "correct horse battery staple";

  it("round-trips and is bound to the business", () => {
    const { secret } = sealed();
    const sealedEnvelope = sealPortableRecoveryEnvelope(secret, passphrase, BUSINESS);
    expect(openPortableRecoveryEnvelope(sealedEnvelope.envelope, passphrase, BUSINESS)).toEqual({
      ok: true,
      secret,
    });
    expect(openPortableRecoveryEnvelope(sealedEnvelope.envelope, passphrase, OTHER_BUSINESS)).toEqual({
      ok: false,
      error: "recovery_passphrase_invalid",
    });
  });

  it("rejects a wrong passphrase and a malformed envelope", () => {
    const { secret } = sealed();
    const { envelope } = sealPortableRecoveryEnvelope(secret, passphrase, BUSINESS);
    expect(openPortableRecoveryEnvelope(envelope, "wrong passphrase here", BUSINESS)).toEqual({
      ok: false,
      error: "recovery_passphrase_invalid",
    });
    expect(openPortableRecoveryEnvelope("POSRKY1.abc", passphrase, BUSINESS)).toEqual({
      ok: false,
      error: "recovery_envelope_invalid",
    });
  });

  it("refuses a trivially short recovery passphrase", () => {
    expect(() => sealPortableRecoveryEnvelope("secret", "short", BUSINESS)).toThrow(/at least 12/);
  });

  it("compares secrets in constant time without leaking length", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});
