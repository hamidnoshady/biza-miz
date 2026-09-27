import { describe, expect, it } from "vitest";
import {
  DATA_OWNERSHIP_REGISTRY,
  REPLICATION_CONTRACT_VERSION,
  REPLICATION_DOMAIN_CONTRACT,
  ownershipFor,
  replicationContractProblems,
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
      if (domain.continuousSync === "active") {
        expect(domain.events.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not claim continuous master-data replication before its event producers exist", () => {
    for (const domain of [
      "customers",
      "products_menu",
      "staff_access",
    ] as const) {
      expect(ownershipFor(domain)).toMatchObject({
        continuousSync: "bootstrap_only",
        events: [],
      });
    }
  });
});
