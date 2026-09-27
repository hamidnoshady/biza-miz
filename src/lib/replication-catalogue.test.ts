import { describe, expect, it } from "vitest";
import { SYNC_EVENT_REGISTRY } from "./sync-event-registry";
import {
  REPLICATION_DOMAIN_DEFINITIONS,
  pairingDataClassification,
  replicationCatalogue,
  replicationCatalogueProblems,
} from "./replication-catalogue";

describe("replication ownership catalogue", () => {
  it("gives every mutable desktop domain one explicit owner and policy", () => {
    expect(REPLICATION_DOMAIN_DEFINITIONS.length).toBeGreaterThan(15);
    for (const domain of REPLICATION_DOMAIN_DEFINITIONS) {
      expect(domain.key).toMatch(/^[a-z_]+$/);
      expect(domain.deploymentProfiles.length, domain.key).toBeGreaterThan(0);
      expect(domain.notes.length, domain.key).toBeGreaterThan(10);
    }
  });

  it("derives pairing event coverage from the actual sync registry", () => {
    expect(replicationCatalogueProblems()).toEqual([]);
    const advertised = pairingDataClassification().ongoingDomainEvents;
    expect(advertised).toEqual([...new Set(SYNC_EVENT_REGISTRY.map((event) => event.type))].sort());
  });

  it("does not hand-maintain an event-name list in a second metadata surface", () => {
    const declared = new Set(replicationCatalogue().flatMap((domain) => domain.eventTypes));
    for (const event of SYNC_EVENT_REGISTRY) expect(declared.has(event.type), event.type).toBe(true);
  });
});
