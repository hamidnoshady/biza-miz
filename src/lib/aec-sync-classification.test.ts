/**
 * Issue #799 §26 — the classification contract, without a database.
 *
 * §26 asks for an *audit*: every new entity classified, the good offline
 * candidates separated from the financial/high-risk ones, and the replication
 * metadata updated if anything is replicated. These assertions are the audit's
 * own checks: §26's eleven named candidates all have an entry, no entity is in
 * both buckets, every entry says what it would need before it could travel, and
 * nothing the catalogue describes is advertised as an ongoing sync domain.
 *
 * The database half — that the schema has no *unclassified* AEC table and that
 * none of them carries the master-data capture trigger — lives in
 * `integration/aec-sync-classification.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { MASTER_SYNC_TABLES } from "./master-sync-registry";
import { SYNC_EVENT_REGISTRY } from "./sync-event-registry";
import {
  AEC_SYNC_CLASSIFICATION,
  AEC_SYNC_CLASS_LABELS,
  AEC_SYNC_ISSUE_OFFLINE_CANDIDATES,
  aecClassifiedTables,
  aecFinancialTables,
  aecOfflineCandidateTables,
  aecSyncClassificationProblems,
} from "./aec-sync-classification";
import { pairingDataClassification, replicationCatalogue } from "./replication-catalogue";

describe("the AEC deployment-mode classification (§26)", () => {
  it("classifies §26's eleven offline candidates, each to a real entry", () => {
    const keys = new Set(AEC_SYNC_CLASSIFICATION.map((entry) => entry.key));
    // Every item in the issue's own list, mapped — this is the audit §26 asked
    // for, so a candidate that silently loses its entry fails here.
    expect(Object.keys(AEC_SYNC_ISSUE_OFFLINE_CANDIDATES).length).toBe(11);
    for (const [candidate, entryKey] of Object.entries(AEC_SYNC_ISSUE_OFFLINE_CANDIDATES)) {
      expect(keys.has(entryKey), `${candidate} → ${entryKey}`).toBe(true);
      const entry = AEC_SYNC_CLASSIFICATION.find((row) => row.key === entryKey)!;
      expect(entry.class, candidate).toBe("offline_candidate");
    }
  });

  it("gives every entry a class, a reason, a conflict rule and a requirement", () => {
    for (const entry of AEC_SYNC_CLASSIFICATION) {
      expect(AEC_SYNC_CLASS_LABELS[entry.class].length, entry.key).toBeGreaterThan(3);
      expect(entry.label.trim().length, entry.key).toBeGreaterThan(2);
      expect(entry.surface.trim().length, entry.key).toBeGreaterThan(2);
      // §26's rule in code: even a candidate may only travel if someone wrote
      // down what the protocol must add — "offline candidate" is not a licence.
      expect(entry.requirement.trim().length, entry.key).toBeGreaterThan(40);
      expect(entry.conflictRule.trim().length, entry.key).toBeGreaterThan(20);
      expect(entry.reason.trim().length, entry.key).toBeGreaterThan(20);
      expect(entry.tables.length, entry.key).toBeGreaterThan(0);
      if (entry.class === "offline_candidate") {
        expect(entry.offlineBoundary, entry.key).not.toBeNull();
      } else {
        // Nothing financial or high-risk has an offline half, by decision.
        expect(entry.offlineBoundary, entry.key).toBeNull();
      }
    }
  });

  it("never puts one table in both buckets", () => {
    const offline = new Set(aecOfflineCandidateTables());
    const financial = new Set(aecFinancialTables());
    for (const table of offline) expect(financial.has(table), table).toBe(false);
    // And the union is exactly what the catalogue declares, with no duplicates.
    const all = aecClassifiedTables();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(offline.size + financial.size + new Set(
      AEC_SYNC_CLASSIFICATION.filter((entry) => entry.class === "cloud_reference").flatMap((e) => e.tables),
    ).size);
  });

  it("keeps every classified table out of the last-write-wins master sync", () => {
    const master = new Set(MASTER_SYNC_TABLES.map((config) => config.table));
    for (const table of aecClassifiedTables()) {
      // §26: financial/high-risk operations must not land in generic
      // master-data merge. Today none of them do — the assertion is that this
      // stays true, and the integration test checks the database trigger too.
      expect(master.has(table), table).toBe(false);
    }
  });

  it("advertises no AEC domain as an ongoing sync source", () => {
    // The pairing screen's coverage copy is a projection of the replication
    // catalogue; a classification that claimed events here would promise a
    // desktop a workflow the cloud has not built.
    const aecDomains = replicationCatalogue().filter((domain) => domain.key.startsWith("aec_"));
    expect(aecDomains.length).toBe(2);
    for (const domain of aecDomains) {
      expect(domain.eventTypes).toEqual([]);
      expect(domain.authority).toBe("cloud_only");
      expect(domain.bootstrap).toBe("none");
      expect(domain.deploymentProfiles).toEqual(["cloud"]);
      expect(domain.notes.length).toBeGreaterThan(30);
    }
    // And no registered event belongs to an AEC table's family: the two domains
    // exist so the pairing copy names the bucket, not so it promises an event.
    const eventTypes = new Set<string>(SYNC_EVENT_REGISTRY.map((event) => event.type));
    for (const domain of aecDomains) {
      for (const event of domain.eventTypes) {
        expect(eventTypes.has(event), event).toBe(true);
      }
    }
  });

  it("names the AEC buckets in the pairing coverage copy", () => {
    // §26 asks for the pairing snapshot to be updated when entities are
    // classified. The derived half is this projection; the snapshot's own copy
    // is asserted in `integration/aec-sync-classification.integration.test.ts`.
    const central = pairingDataClassification().centralOnlyData;
    expect(central).toContain("AEC field capture (site logs, inspections, snags, RFI drafts)");
    expect(central).toContain(
      "AEC commercial registers (BOQ, variations, certificates, procurement, transmittals)",
    );
    // And nothing AEC is advertised as synchronising.
    expect(pairingDataClassification().ongoingDomainEvents.some((event) => event.includes("aec"))).toBe(false);
  });

  it("reports an unclassified or a vanished table, and nothing when the schema agrees", () => {
    const known = aecClassifiedTables();
    expect(aecSyncClassificationProblems(known)).toEqual({ uncovered: [], unknown: [] });

    const withNew = aecSyncClassificationProblems([...known, "aec_new_register"]);
    expect(withNew.uncovered).toEqual(["aec_new_register"]);
    expect(withNew.unknown).toEqual([]);

    const withDropped = aecSyncClassificationProblems(known.filter((table) => table !== "aec_rfis"));
    expect(withDropped.uncovered).toEqual([]);
    expect(withDropped.unknown).toEqual(["aec_rfis"]);
  });
});
