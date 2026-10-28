import { describe, expect, it } from "vitest";
import {
  buildTenantInventory,
  queryInventory,
  summarizeInventory,
  type TenantArtifactRow,
} from "./tenant-backup-inventory";

const BUSINESS = "biz-a";
const OTHER = "biz-b";
const NOW = new Date("2026-10-28T12:00:00Z");

function row(overrides: Partial<TenantArtifactRow> = {}): TenantArtifactRow {
  return {
    artifactId: "artifact-1",
    businessId: BUSINESS,
    destination: "local",
    format: "logical_snapshot",
    origin: "scheduled",
    state: "ready",
    payloadBytes: 1_000,
    storedBytes: 1_040,
    capturedAt: "2026-10-27T03:30:00Z",
    verifiedAt: "2026-10-27T03:31:00Z",
    retentionUntil: "2026-11-26T03:30:00Z",
    lastRestoreAt: null,
    completeness: "complete",
    encryption: "managed_envelope_v1",
    storageRef: "local:pos-backup-20261027.dump.enc",
    failureCode: null,
    ...overrides,
  };
}

const CLOUD = { profile: "cloud" as const, connectivity: "online" as const, now: NOW };

describe("buildTenantInventory", () => {
  it("drops another business's rows even when they reach the function", () => {
    expect(buildTenantInventory([row({ businessId: OTHER })], BUSINESS, CLOUD)).toEqual([]);
  });

  it("collapses a mirror into one entry with two destination views", () => {
    const entries = buildTenantInventory(
      [
        row({ destination: "local", storedBytes: 1_040 }),
        row({ destination: "cloud", storedBytes: 1_040, storageRef: "cloud:tenant/artifact-1", state: "ready" }),
      ],
      BUSINESS,
      { profile: "hybrid", connectivity: "online", now: NOW },
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.destinations.map((destination) => destination.destination)).toEqual(["cloud", "local"]);
    expect(entry.payloadBytes).toBe(1_000);
    expect(entry.state).toBe("ready");
    expect(entry.restorable).toBe(true);
    expect(entry.downloadable).toBe(true);
    // One logical backup counted once: the two stored copies are the mirror, not
    // two backups.
    expect(entry.storedBytes).toBe(2_080);
    expect(summarizeInventory(entries, { includedBytes: 10_000 }).cloudBytes).toBe(1_040);
  });

  it("hides every cloud row from a Local-only tenant", () => {
    const entries = buildTenantInventory(
      [row({ destination: "local" }), row({ destination: "cloud", storageRef: "cloud:x" })],
      BUSINESS,
      { profile: "local", connectivity: "offline", now: NOW },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].destinations.map((destination) => destination.destination)).toEqual(["local"]);
    // Offline local bytes are not a download the platform can serve right now.
    expect(entries[0].state).toBe("unavailable_offline");
    expect(entries[0].downloadable).toBe(false);
    expect(entries[0].restorable).toBe(false);
    expect(summarizeInventory(entries, { includedBytes: 10_000 }).cloudBytes).toBe(0);
  });

  it("labels a queued hybrid upload as uploading, never as a completed cloud copy", () => {
    const entries = buildTenantInventory(
      [
        row({ destination: "local" }),
        row({ destination: "cloud", state: "pending_upload", verifiedAt: null, storageRef: "cloud:x" }),
      ],
      BUSINESS,
      { profile: "hybrid", connectivity: "offline", now: NOW },
    );
    expect(entries[0].state).toBe("uploading");
    const cloud = entries[0].destinations.find((destination) => destination.destination === "cloud");
    expect(cloud).toMatchObject({ state: "uploading", available: false, verified: false });
    expect(entries[0].restorable).toBe(false);
  });

  it("keeps writing-not-verified artifacts out of 'ready'", () => {
    const entries = buildTenantInventory(
      [row({ state: "verifying", verifiedAt: null })],
      BUSINESS,
      CLOUD,
    );
    expect(entries[0].state).toBe("verifying");
    expect(entries[0].integrity).toBe("unverified");
    expect(entries[0].restorable).toBe(false);
  });

  it("marks a failed copy as failed even when its mirror is healthy", () => {
    const entries = buildTenantInventory(
      [
        row({ destination: "local" }),
        row({ destination: "cloud", state: "failed", failureCode: "upload_failed", storageRef: "cloud:x" }),
      ],
      BUSINESS,
      { profile: "hybrid", connectivity: "online", now: NOW },
    );
    expect(entries[0].state).toBe("failed");
    expect(entries[0].integrity).toBe("failed");
    expect(entries[0].destinations.find((destination) => destination.destination === "local")).toMatchObject({
      state: "ready",
      available: true,
    });
  });

  it("expires an artifact whose retention ended", () => {
    const entries = buildTenantInventory(
      [row({ retentionUntil: "2026-10-01T00:00:00Z" })],
      BUSINESS,
      CLOUD,
    );
    expect(entries[0].state).toBe("expired");
    expect(entries[0].available).toBe(false);
  });

  it("does not call an unverified upload restorable", () => {
    const entries = buildTenantInventory(
      [row({ origin: "uploaded", destination: "cloud", verifiedAt: null, storageRef: "cloud:upload" })],
      BUSINESS,
      CLOUD,
    );
    expect(entries[0].origin).toBe("uploaded");
    expect(entries[0].restorable).toBe(false);
    expect(entries[0].downloadable).toBe(false);
  });

  it("reports partial completeness and legacy encryption without provider detail", () => {
    const entries = buildTenantInventory(
      [row({ completeness: "partial", encryption: "legacy_passphrase_v1" })],
      BUSINESS,
      CLOUD,
    );
    expect(entries[0].completeness).toBe("partial");
    expect(entries[0].encryption).toBe("legacy_passphrase");
    expect(JSON.stringify(entries[0])).not.toContain("pos-backup");
    expect(JSON.stringify(entries[0])).not.toContain("tenant/artifact");
  });
});

describe("queryInventory", () => {
  const entries = buildTenantInventory(
    [
      row({ artifactId: "a", capturedAt: "2026-10-01T00:00:00Z", origin: "scheduled", storageRef: "s1" }),
      row({ artifactId: "b", capturedAt: "2026-10-02T00:00:00Z", origin: "manual", storageRef: "s2" }),
      row({ artifactId: "c", capturedAt: "2026-10-03T00:00:00Z", origin: "uploaded", storageRef: "s3" }),
      row({ artifactId: "d", capturedAt: "2026-10-04T00:00:00Z", state: "failed", storageRef: "s4" }),
    ],
    BUSINESS,
    CLOUD,
  );

  it("sorts newest first and paginates within the cap", () => {
    const page = queryInventory(entries, { pageSize: 2, page: 1 });
    expect(page.total).toBe(4);
    expect(page.pages).toBe(2);
    expect(page.items.map((entry) => entry.capturedAt)).toEqual([
      "2026-10-04T00:00:00Z",
      "2026-10-03T00:00:00Z",
    ]);
    expect(queryInventory(entries, { pageSize: 999 }).pageSize).toBe(50);
    expect(queryInventory(entries, { page: 99 }).page).toBe(queryInventory(entries, { page: 99 }).pages);
  });

  it("filters by state and origin", () => {
    expect(queryInventory(entries, { state: "failed" }).items).toHaveLength(1);
    expect(queryInventory(entries, { origin: "uploaded" }).items).toHaveLength(1);
    expect(queryInventory(entries, { origin: "manual", state: "ready" }).total).toBe(1);
  });

  it("searches the human-facing labels and the opaque ref", () => {
    expect(queryInventory(entries, { search: "آماده" }).total).toBe(3);
    const ref = entries[0].ref;
    expect(queryInventory(entries, { search: ref }).total).toBe(1);
  });
});

describe("summarizeInventory", () => {
  it("counts cloud bytes against the allowance, never local bytes", () => {
    const entries = buildTenantInventory(
      [
        row({ artifactId: "a", destination: "cloud", storedBytes: 6_000, storageRef: "c1" }),
        row({ artifactId: "a", destination: "local", storedBytes: 6_000 }),
        row({ artifactId: "b", destination: "cloud", storedBytes: 2_000, state: "failed", storageRef: "c2" }),
      ],
      BUSINESS,
      { profile: "hybrid", connectivity: "online", now: NOW },
    );
    const summary = summarizeInventory(entries, { includedBytes: 10_000 });
    expect(summary.cloudBytes).toBe(8_000);
    expect(summary.overageBytes).toBe(0);
    expect(summary.usagePercent).toBe(80);
    expect(summary.failedCount).toBe(1);
    expect(summary.readyCount).toBe(1);
    expect(summary.latestVerifiedAt).toBe("2026-10-27T03:30:00Z");
  });

  it("reports overage and pending work honestly", () => {
    const entries = buildTenantInventory(
      [
        row({ artifactId: "a", destination: "cloud", storedBytes: 12_000, storageRef: "c1" }),
        row({ artifactId: "b", destination: "cloud", state: "pending_upload", storageRef: "c2" }),
      ],
      BUSINESS,
      { profile: "cloud", connectivity: "online", now: NOW },
    );
    const summary = summarizeInventory(entries, { includedBytes: 10_000 });
    expect(summary.overageBytes).toBe(2_000);
    expect(summary.pendingCount).toBe(1);
    expect(summary.latestCompletedAt).toBe("2026-10-27T03:30:00Z");
  });
});
