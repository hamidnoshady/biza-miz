import { describe, expect, it } from "vitest";
import {
  DATA_OWNERSHIP_REGISTRY,
  REPLICATION_CONTRACT_VERSION,
  REPLICATION_DOMAIN_CONTRACT,
  ownershipFor,
  replicationContractProblems,
  unclaimedMasterTables,
} from "./data-ownership";

describe("replication-domain contract", () => {
  it("never gives financial or inventory events timestamp overwrite semantics", () => {
    for (const domain of [
      "payments",
      "accounting_journals",
      "inventory_movements",
    ] as const) {
      expect(["append_only", "append_or_reverse"]).toContain(
        ownershipFor(domain).conflictPolicy,
      );
    }
  });

  it("keeps filesystem and printer configuration device-local", () => {
    for (const domain of [
      "printer_settings",
      "backup_paths",
      "lan_gateway",
      "certificate_paths",
      "database_paths",
      "cloud_exception_transport",
    ] as const) {
      expect(DATA_OWNERSHIP_REGISTRY[domain]).toMatchObject({
        authority: "device_local",
        direction: "none",
        conflictPolicy: "never_sync",
        continuousSync: "not_replicated",
      });
    }
  });

  it("is versioned, executable, and never advertises Local-only as cloud sync", () => {
    expect(REPLICATION_DOMAIN_CONTRACT.version).toBe(
      REPLICATION_CONTRACT_VERSION,
    );
    expect(replicationContractProblems()).toEqual([]);
    for (const domain of REPLICATION_DOMAIN_CONTRACT.domains) {
      expect(domain.identity).not.toHaveLength(0);
      expect(domain.retry).not.toHaveLength(0);
      expect(
        domain.deploymentAvailability.continuousSyncProfiles,
      ).not.toContain("local");
      if (domain.continuousSync === "active" && domain.transport === "events") {
        expect(domain.events.length).toBeGreaterThan(0);
      }
    }
  });

  it("syncs customers and the menu continuously, merged field by field, through the master feed", () => {
    for (const domain of ["customers", "products_menu"] as const) {
      expect(ownershipFor(domain)).toMatchObject({
        continuousSync: "active",
        transport: "master_feed",
        direction: "bidirectional",
        conflictPolicy: "field_merge_with_version",
      });
    }
    // Every table the capture trigger records belongs to one declared domain.
    expect(unclaimedMasterTables()).toEqual([]);
  });

  it("keeps staff access on its own control plane, not the master feed", () => {
    expect(ownershipFor("staff_access")).toMatchObject({
      continuousSync: "bootstrap_only",
      transport: "none",
      events: [],
    });
  });

  it("carries open-order state and closed-order amendments as order events", () => {
    const events = ownershipFor("orders").events.map((entry) => `${entry.type}@${entry.schemaVersion}`);
    expect(events).toEqual(expect.arrayContaining(["order.state.synced@1", "order.amendment.posted@1"]));
  });
});
