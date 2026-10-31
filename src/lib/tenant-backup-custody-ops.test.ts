import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn(), withoutTenantScope: vi.fn() }));
vi.mock("./master-key", () => ({ getMasterKey: () => Buffer.alloc(32, 1) }));

import { assessCustodyCoverage, type CustodyArtifact } from "./tenant-backup-custody-ops";

function artifact(patch: Partial<CustodyArtifact> = {}): CustodyArtifact {
  return {
    ref: "ref-1",
    keyVersion: 1,
    encryption: "managed_envelope_v1",
    state: "ready",
    storageRef: "a.enc",
    ...patch,
  };
}

describe("assessCustodyCoverage", () => {
  it("is complete when every generation still unwraps", () => {
    const coverage = assessCustodyCoverage({
      artifacts: [artifact({ ref: "a" }), artifact({ ref: "b", keyVersion: 2 })],
      readableVersions: [1, 2],
      kekAvailable: true,
    });
    expect(coverage).toEqual({ missingVersions: [], unreadableRefs: [], legacyRefs: [], complete: true });
  });

  it("names the generations that are gone, and every artifact they protect", () => {
    const coverage = assessCustodyCoverage({
      artifacts: [artifact({ ref: "a", keyVersion: 1 }), artifact({ ref: "b", keyVersion: 7 })],
      readableVersions: [1],
      kekAvailable: true,
    });
    expect(coverage.missingVersions).toEqual([7]);
    expect(coverage.unreadableRefs).toEqual(["b"]);
    expect(coverage.complete).toBe(false);
  });

  it("reports legacy artifacts separately: the Owner can open them, the platform cannot", () => {
    const coverage = assessCustodyCoverage({
      artifacts: [artifact({ ref: "old", encryption: "legacy_passphrase_v1", keyVersion: null })],
      readableVersions: [],
      kekAvailable: true,
    });
    expect(coverage.legacyRefs).toEqual(["old"]);
    expect(coverage.unreadableRefs).toEqual([]);
    expect(coverage.complete).toBe(false);
  });

  it("ignores rows that are already superseded or expired — they are not restorable anyway", () => {
    const coverage = assessCustodyCoverage({
      artifacts: [
        artifact({ ref: "old", state: "superseded", keyVersion: 9 }),
        artifact({ ref: "gone", state: "expired", keyVersion: 9 }),
      ],
      readableVersions: [],
      kekAvailable: true,
    });
    expect(coverage).toEqual({ missingVersions: [], unreadableRefs: [], legacyRefs: [], complete: true });
  });

  it("is never complete without a platform key, whatever the rows say", () => {
    const coverage = assessCustodyCoverage({
      artifacts: [artifact()],
      readableVersions: [1],
      kekAvailable: false,
    });
    expect(coverage.complete).toBe(false);
  });
});
