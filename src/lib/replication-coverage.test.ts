import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_OWNERSHIP_REGISTRY } from "./data-ownership";
import {
  COVERAGE_CLASSES,
  COVERAGE_CLASS_IDS,
  KNOWN_CATALOGUE_DISCREPANCIES,
  catalogueDiscrepancies,
  coverageApplyOrder,
  coverageBinaryTransport,
  coverageClass,
  fullySyncedBlockers,
  localReplicaStatus,
  renderReplicationCoverageMarkdown,
  unclassifiedDomains,
  unverifiableRequiredClasses,
  type CoverageEvidence,
} from "./replication-coverage";

const CLEAN: CoverageEvidence = {
  verified: Object.fromEntries(COVERAGE_CLASS_IDS.map((id) => [id, true])),
  identityBlocked: false,
  credentialsMissing: 0,
  pendingOutbox: 0,
  deferredEvents: 0,
  deadLetters: 0,
  masterConflicts: 0,
  checksumMismatch: false,
  cloudAcknowledged: true,
};

describe("replication coverage manifest", () => {
  it("has one class per declared id and covers every epic §C audit class", () => {
    expect(COVERAGE_CLASSES.map((entry) => entry.id)).toEqual([...COVERAGE_CLASS_IDS]);
    const audit = COVERAGE_CLASSES.map((entry) => entry.auditClass).join(" | ");
    for (const needle of [
      "Tenant",
      "IAM",
      "Customers",
      "Menu",
      "POS",
      "Stock",
      "Ledger",
      "Settings",
      "Media",
      "installed",
    ]) {
      expect(audit, needle).toContain(needle);
    }
  });

  it("places every ownership domain and every catalogue key in exactly one class", () => {
    expect(unclassifiedDomains()).toEqual([]);
  });

  it("applies classes after everything they depend on, with no cycle", () => {
    const order = coverageApplyOrder();
    expect(new Set(order).size).toBe(COVERAGE_CLASS_IDS.length);
    for (const entry of COVERAGE_CLASSES) {
      for (const dependency of entry.dependsOn) {
        expect(order.indexOf(dependency), `${entry.id} before ${dependency}`).toBeLessThan(order.indexOf(entry.id));
      }
    }
  });

  it("derives the local replica status instead of declaring it", () => {
    expect(localReplicaStatus(coverageClass("device_local"))).toBe("device_local");
    expect(localReplicaStatus(coverageClass("pos_operations"))).toBe("continuous");
    expect(localReplicaStatus(coverageClass("identity_iam"))).toBe("bootstrap_only");
    expect(localReplicaStatus(coverageClass("installed_apps"))).toBe("mixed");
    // A device-local domain can never be required for readiness.
    for (const entry of COVERAGE_CLASSES) {
      if (entry.domains.every((domain) => DATA_OWNERSHIP_REGISTRY[domain].authority === "device_local") && entry.domains.length > 0) {
        expect(entry.requiredForReady, entry.id).toBe(false);
      }
    }
  });

  it("reports on-demand file transfer for media rather than claiming files are local", () => {
    expect(coverageBinaryTransport(coverageClass("media_assets"))).toContain("on_demand");
  });

  it("pins the disagreements between the pairing catalogue and the ownership contract", () => {
    const found = catalogueDiscrepancies().map((entry) => `${entry.domain}↔${entry.catalogueKey}`).sort();
    expect(found).toEqual([...KNOWN_CATALOGUE_DISCREPANCIES]);
  });

  describe("fullySyncedBlockers", () => {
    it("refuses to call a site fully synced while a required class has no verifier", () => {
      const blockers = fullySyncedBlockers(CLEAN);
      expect(unverifiableRequiredClasses().length).toBeGreaterThan(0);
      for (const id of unverifiableRequiredClasses()) {
        expect(blockers).toContain(`class_unverifiable:${id}`);
      }
      // Clean evidence alone is never enough: nothing is claimed that cannot be compared.
      expect(blockers.length).toBeGreaterThan(0);
    });

    it("names each runtime blocker separately", () => {
      const blockers = fullySyncedBlockers({
        ...CLEAN,
        identityBlocked: true,
        credentialsMissing: 2,
        pendingOutbox: 1,
        deferredEvents: 1,
        deadLetters: 1,
        masterConflicts: 1,
        checksumMismatch: true,
        cloudAcknowledged: false,
      });
      for (const code of [
        "identity_blocked",
        "credentials_missing",
        "pending_outbox",
        "deferred_events",
        "dead_letters",
        "master_conflicts",
        "checksum_mismatch",
        "cloud_not_acknowledged",
      ]) {
        expect(blockers, code).toContain(code);
      }
    });

    it("treats missing evidence as unverified, never as agreement", () => {
      const blockers = fullySyncedBlockers({ ...CLEAN, verified: {} });
      for (const entry of COVERAGE_CLASSES.filter((candidate) => candidate.requiredForReady && candidate.verifier !== "none")) {
        expect(blockers).toContain(`class_unverified:${entry.id}`);
      }
    });

    it("does not require non-required classes", () => {
      const blockers = fullySyncedBlockers({ ...CLEAN, verified: {} }).join(" ");
      expect(blockers).not.toContain("device_local");
      expect(blockers).not.toContain("installed_apps");
      expect(blockers).not.toContain("media_assets");
    });
  });

  it("keeps docs/architecture/replication-coverage.md identical to the manifest", () => {
    const doc = readFileSync(join(process.cwd(), "docs/architecture/replication-coverage.md"), "utf8");
    expect(doc, "Run: npx tsx scripts/render-replication-coverage.ts").toBe(renderReplicationCoverageMarkdown());
  });
});
