import { describe, expect, it } from "vitest";
import { PERMISSIONS, roleBasePermissions } from "./permissions";
import { permissionMetadata } from "./permission-registry";
import { DATA_OWNERSHIP_REGISTRY } from "./data-ownership";
import { replicationCatalogue } from "./replication-catalogue";
import { SYNC_EVENT_REGISTRY, siteSkipsPulledEvent } from "./sync-event-registry";
import { classifyPartyReference, partyReferenceFor } from "./party-merge-references";

const SHAREHOLDER_EFFECTS = [
  "shareholder.capital.recorded",
  "shareholder.capital.reversed",
  "shareholder.distribution.posted",
  "shareholder.distribution.payment.recorded",
  "shareholder.distribution.payment.reversed",
  "shareholder.distribution.reversed",
] as const;

describe("shareholder Accounting authority and sync contract (#864)", () => {
  it("declares the cloud as the authority and sites as acknowledgement-only consumers", () => {
    expect(DATA_OWNERSHIP_REGISTRY.shareholder_accounting).toMatchObject({
      authority: "cloud_authoritative",
      direction: "cloud_to_site",
      conflictPolicy: "immutable_idempotent",
      transport: "events",
      continuousSync: "active",
    });
    const catalogue = replicationCatalogue().find((domain) => domain.key === "shareholder_accounting");
    expect(catalogue).toMatchObject({
      authority: "cloud_only",
      locationScope: "business",
      deploymentProfiles: ["cloud", "hybrid"],
    });
    expect(catalogue?.eventTypes).toEqual(expect.arrayContaining([...SHAREHOLDER_EFFECTS]));
    expect(catalogue?.eventTypes).toHaveLength(SHAREHOLDER_EFFECTS.length);

    for (const type of SHAREHOLDER_EFFECTS) {
      const event = SYNC_EVENT_REGISTRY.find((candidate) => candidate.type === type && candidate.schemaVersion === 1);
      expect(event, type).toBeDefined();
      expect(event?.locationRule, type).toBe("business");
      expect(event?.effectClass, type).toBe("shareholder_accounting");
      expect(siteSkipsPulledEvent(event!), type).toBe(true);
    }
  });

  it("blocks party merges that would rewrite legal shareholder identity and preserves frozen recipient history", () => {
    expect(classifyPartyReference("shareholder_accounts", "party_id")).toBe("blocked");
    expect(partyReferenceFor("shareholder_accounts", "party_id")?.reason).toMatch(/ownership transfer/i);
    expect(classifyPartyReference("shareholder_distribution_lines", "party_id")).toBe("historical");
    expect(classifyPartyReference("shareholder_distribution_payments", "party_id")).toBe("historical");
  });

  it("grants accountants day-to-day access but reserves backdating and financial reversals", () => {
    const accountant = new Set(roleBasePermissions("accountant"));
    expect(accountant.has(PERMISSIONS.shareholdersView)).toBe(true);
    expect(accountant.has(PERMISSIONS.shareholdersManage)).toBe(true);
    expect(accountant.has(PERMISSIONS.shareholdersCapitalPost)).toBe(true);
    expect(accountant.has(PERMISSIONS.shareholdersDistributionsManage)).toBe(true);
    expect(accountant.has(PERMISSIONS.shareholdersDistributionsAdjust)).toBe(true);
    expect(accountant.has(PERMISSIONS.shareholdersDistributionsApprove)).toBe(true);
    expect(accountant.has(PERMISSIONS.shareholdersDistributionsPay)).toBe(true);
    expect(accountant.has(PERMISSIONS.shareholdersRetroactive)).toBe(false);
    expect(accountant.has(PERMISSIONS.shareholdersCapitalReverse)).toBe(false);
    expect(accountant.has(PERMISSIONS.shareholdersDistributionsReverse)).toBe(false);

    const adjustment = permissionMetadata(PERMISSIONS.shareholdersDistributionsAdjust);
    expect(adjustment).toMatchObject({ group: "accounting", risk: "high", audit: true });
    expect(adjustment.label).not.toBe(adjustment.key);
  });
});
