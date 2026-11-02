/**
 * Issue #903 — the legacy projection that keeps pre-existing backups visible
 * without pretending they are managed artifacts.
 *
 * The run history is the only record of artifacts produced before this epic. It
 * has no manifest, no custody generation and no verification, so the projection
 * must be honest (legacy encryption, unverified, partial) and must not invent a
 * second logical backup for the two rows of one mirror.
 */
import { describe, expect, it } from "vitest";
import { legacyArtifactRowsFromRuns } from "./tenant-backup-artifacts-service";
import type { BackupRunRow } from "./backup-service";

const BUSINESS = "business-a";

function run(overrides: Partial<BackupRunRow> = {}): BackupRunRow {
  return {
    id: "run-1",
    kind: "local",
    trigger: "scheduled",
    status: "success",
    scope: "logical",
    artifact: "pos-backup-abcd1234-20261020-033000.sql.enc",
    cloudKey: null,
    sizeBytes: 4_096,
    error: null,
    startedAt: "2026-10-20T03:30:00.000Z",
    finishedAt: "2026-10-20T03:30:20.000Z",
    ...overrides,
  };
}

describe("legacyArtifactRowsFromRuns", () => {
  it("projects a successful run honestly, never as a managed artifact", () => {
    const [row] = legacyArtifactRowsFromRuns(BUSINESS, [run()]);
    expect(row).toMatchObject({
      businessId: BUSINESS,
      destination: "local",
      format: "logical_snapshot",
      origin: "scheduled",
      state: "ready",
      encryption: "legacy_passphrase_v1",
      completeness: "partial",
      verifiedAt: null,
      manifest: null,
      manifestSignature: null,
      payloadBytes: 4_096,
      capturedAt: "2026-10-20T03:30:20.000Z",
    });
  });

  it("ignores failed, running and artifact-less runs", () => {
    const rows = legacyArtifactRowsFromRuns(BUSINESS, [
      run({ id: "failed", status: "failed", error: "disk full" }),
      run({ id: "running", status: "running", finishedAt: null }),
      run({ id: "no-artifact", artifact: null }),
    ]);
    expect(rows).toEqual([]);
  });

  it("groups the local and cloud rows of one artifact under one artifact id", () => {
    const rows = legacyArtifactRowsFromRuns(BUSINESS, [
      run({ id: "local", kind: "local" }),
      run({ id: "cloud", kind: "cloud", cloudKey: "tenant/backups/pos-backup-abcd1234.sql.enc" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.artifactId)).size).toBe(1);
    expect(rows.map((row) => row.destination).sort()).toEqual(["cloud", "local"]);
  });

  it("keeps the artifact id stable per business and artifact", () => {
    const [first] = legacyArtifactRowsFromRuns(BUSINESS, [run()]);
    const [again] = legacyArtifactRowsFromRuns(BUSINESS, [run({ id: "different-run-row" })]);
    const [other] = legacyArtifactRowsFromRuns("business-b", [run()]);
    expect(first.artifactId).toBe(again.artifactId);
    expect(first.artifactId).not.toBe(other.artifactId);
  });

  it("marks a physical scope as a physical dump", () => {
    const [row] = legacyArtifactRowsFromRuns(BUSINESS, [run({ scope: "physical" })]);
    expect(row.format).toBe("physical_dump");
  });

  it("carries no provider detail in the projected row", () => {
    const [row] = legacyArtifactRowsFromRuns(BUSINESS, [
      run({ kind: "cloud", cloudKey: "tenant/backups/pos-backup-abcd1234.sql.enc" }),
    ]);
    // The internal storage reference is not a bucket, endpoint or key — and the
    // tenant DTO never serializes it at all.
    expect(row.storageRef).toBe(`cloud:${run().artifact}`);
    expect(JSON.stringify(row)).not.toContain("bucket");
    expect(JSON.stringify(row)).not.toContain("endpoint");
  });
});
