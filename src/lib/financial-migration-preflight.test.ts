import { describe, expect, it } from "vitest";
import { assessReadiness, preflightDatabase, type ReviewEvidence } from "./financial-migration-preflight";

const baseline = {
  snapshotSha256: "a".repeat(64), registeredAccounts: 4, invalidAccountLinks: 0,
  missingTerminalBanks: 0, unattributedPayments: 0, missingPaymentMethods: 0,
  pooledBalances: ["0"], unbalancedEntries: 0, openReconciliations: 0,
  pendingRefundsAndReversals: 0, queuedSyncEvents: 0, failedSyncEvents: 0,
  unknownClientVersions: 0, linkedDesktopDevices: 0, registeredUnsettledBalances: ["500"],
};

const approved: ReviewEvidence = {
  snapshotSha256: baseline.snapshotSha256,
  encryptedBackupEvidenceSha256: "b".repeat(64), testedRestoreEvidenceSha256: "c".repeat(64),
  clientAndQueueEvidenceSha256: "d".repeat(64), ownerMappingEvidenceSha256: "e".repeat(64),
  pendingSettlementEvidenceSha256: "f".repeat(64),
};

describe("existing-business preflight", () => {
  it("refuses remote, ordinary, malformed, and parameterized database targets", () => {
    for (const target of [undefined, "postgresql://app@prod.example/esh154_preflight_copy",
      "postgresql://app@localhost/bizamiz", "postgresql://app@localhost/esh154_preflight_copy?host=prod.example",
      "postgresql://app@localhost/esh154_preflight_copy#fragment", "postgresql://app@localhost/esh154_preflight_",
      "postgresql://app@localhost/esh154_preflight_copy/path"]) {
      expect(() => preflightDatabase(target)).toThrow(/loopback/);
    }
    expect(preflightDatabase("postgresql://reader@127.0.0.1/esh154_preflight_copy")).toBe("esh154_preflight_copy");
  });

  it("blocks missing or stale recovery evidence and operational backlogs", () => {
    expect(assessReadiness(baseline).blockers).toContain("encrypted_backup_not_verified");
    expect(assessReadiness({ ...baseline, queuedSyncEvents: 1, openReconciliations: 1 }, approved)).toMatchObject({
      classification: "BLOCKED", blockers: expect.arrayContaining(["queued_sync_events", "open_reconciliations"]),
    });
    expect(assessReadiness({ ...baseline, snapshotSha256: "9".repeat(64) }, approved).blockers)
      .toContain("evidence_does_not_match_snapshot");
    expect(assessReadiness({ ...baseline, unbalancedEntries: 2 }, approved).blockers).toContain("unbalanced_journal_entries");
    expect(assessReadiness({ ...baseline, linkedDesktopDevices: 1 }, approved).blockers)
      .toContain("hybrid_payment_routing_not_supported");
  });

  it("requires owner mapping for real exceptions and does not clear invalid links with evidence", () => {
    expect(assessReadiness({ ...baseline, pooledBalances: ["1", "-1"], unattributedPayments: 3 }, {
      ...approved, ownerMappingEvidenceSha256: undefined,
    })).toMatchObject({ classification: "NEEDS OWNER MAPPING", ownerMapping: expect.arrayContaining([
      "pooled_bank_or_clearing_balance", "unattributed_historical_payments",
    ]) });
    expect(assessReadiness({ ...baseline, missingTerminalBanks: 1 }, approved).classification).toBe("NEEDS OWNER MAPPING");
    expect(assessReadiness(baseline, approved).classification).toBe("READY");
  });
});
