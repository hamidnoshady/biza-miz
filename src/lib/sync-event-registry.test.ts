import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifySyncDomainError } from "./sync-events";
import { SyncPayloadError } from "./sync-domain-handlers";
import {
  isOfflineQueueEligible,
  siteSkipsPulledEvent,
  publicSyncEventRegistry,
  SYNC_EVENT_REGISTRY,
  syncEventDefinition,
  type SyncEventDefinition,
} from "./sync-event-registry";

describe("authoritative sync event registry", () => {
  it("has unique exact-version keys and no implicit version fallback", () => {
    const keys = SYNC_EVENT_REGISTRY.map((entry) => `${entry.type}@${entry.schemaVersion}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SYNC_EVENT_REGISTRY) {
      expect(syncEventDefinition(entry.type, entry.schemaVersion)?.handler).toBe(entry.handler);
      expect(syncEventDefinition(entry.type, entry.schemaVersion + 1000)).toBeNull();
      expect(entry.permission).toMatch(/^[a-z][a-z_.]+$/);
      expect(entry.payloadFields).not.toContain("businessId");
      expect(entry.payloadFields).not.toContain("locationId");
    }
  });

  it("has one implemented switch handler for every and only transactional definition", () => {
    const source = readFileSync(path.resolve("src/lib/sync-domain-handlers.ts"), "utf8");
    const implemented = [...source.matchAll(/case\s+"([^"]+)"\s*:/g)].map((match) => match[1]).sort();
    const registered = SYNC_EVENT_REGISTRY.filter((entry) => !("legacy" in entry && entry.legacy)).map((entry) => entry.handler).sort();
    expect(implemented).toEqual(registered);
  });

  it("publishes operational metadata without handlers or dependency internals", () => {
    const published = publicSyncEventRegistry();
    expect(published.events).toHaveLength(SYNC_EVENT_REGISTRY.length);
    expect(JSON.stringify(published)).not.toContain("handler");
    expect(JSON.stringify(published)).not.toContain("dependencyErrors");
    expect(published.events.every((event) => {
      const source = SYNC_EVENT_REGISTRY.find(
        (entry) => entry.type === event.type && entry.schemaVersion === event.schemaVersion,
      );
      const legacy = Boolean(source && "legacy" in source && source.legacy);
      return event.transactionalDomainEffect === !legacy;
    })).toBe(true);
  });

  it("requires business-scoped transfer rules only for transfer effects", () => {
    for (const entry of SYNC_EVENT_REGISTRY) {
      expect(entry.locationRule === "business_transfer").toBe(entry.effectClass === "transfer");
    }
  });
});

describe("offline queue eligibility (Section 5 audit extension)", () => {
  it("accepts the three legacy order actions the client queue originally shipped with", () => {
    expect(isOfflineQueueEligible("order.create", 1)).toBe(true);
    expect(isOfflineQueueEligible("order.add_items", 1)).toBe(true);
    expect(isOfflineQueueEligible("order_item.status", 1)).toBe(true);
  });

  it("accepts inventory.waste.recorded, the one domain explicitly opted in", () => {
    expect(isOfflineQueueEligible("inventory.waste.recorded", 1)).toBe(true);
  });

  it("rejects every other transactional definition — existing in the server-to-server registry is not enough on its own", () => {
    for (const entry of SYNC_EVENT_REGISTRY) {
      const legacy = "legacy" in entry && entry.legacy;
      if (legacy || entry.type === "inventory.waste.recorded") continue;
      expect(isOfflineQueueEligible(entry.type, entry.schemaVersion)).toBe(false);
    }
  });

  it("rejects an unknown type/schema version", () => {
    expect(isOfflineQueueEligible("not.a.real.type", 1)).toBe(false);
    expect(isOfflineQueueEligible("order.create", 999)).toBe(false);
  });
});

describe("sync domain failure classification", () => {
  const payment = syncEventDefinition("order.payment.completed", 1) as SyncEventDefinition;

  it("defers declared prerequisites and terminally rejects payload/domain violations", () => {
    expect(classifySyncDomainError(new Error("order_not_found"), payment)).toBe("deferred");
    expect(classifySyncDomainError(new SyncPayloadError("invalid_method"), payment)).toBe("terminal");
    expect(classifySyncDomainError(new Error("refund_exceeds_payment"), payment)).toBe("terminal");
    // A second open shift for one person is the owner's to resolve, not a retry.
    const shiftOpened = syncEventDefinition("shift.opened", 1) as SyncEventDefinition;
    expect(classifySyncDomainError(new Error("employee_not_found"), shiftOpened)).toBe("deferred");
    expect(classifySyncDomainError(new Error("shift_already_open"), shiftOpened)).toBe("terminal");
  });

  it("keeps SQL, network, injected and unexpected programming failures retryable", () => {
    expect(classifySyncDomainError(Object.assign(new Error("serialization"), { code: "40001" }), payment)).toBe("transient");
    expect(classifySyncDomainError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), payment)).toBe("transient");
    expect(classifySyncDomainError(new Error("injected_sync_failure_after_domain_effect"), payment)).toBe("transient");
    expect(classifySyncDomainError(new TypeError("cannot read property"), payment)).toBe("transient");
  });
});

describe("pulled cloud events a desktop acknowledges without applying (Phase 46)", () => {
  it("skips stock, transfers and ledger reversals — the cloud owns them since Phase 45", () => {
    const skipped = SYNC_EVENT_REGISTRY.filter((definition) => siteSkipsPulledEvent(definition)).map((d) => d.type);
    expect(skipped).toContain("inventory.purchase.created");
    expect(skipped).toContain("inventory.purchase.received");
    expect(skipped).toContain("accounting.manual_journal.reversed");
  });

  it("still applies everything the till needs: orders, payments, refunds and shifts", () => {
    for (const definition of SYNC_EVENT_REGISTRY) {
      if (["order", "payment", "refund", "shift"].includes(definition.effectClass)) {
        expect(siteSkipsPulledEvent(definition), definition.type).toBe(false);
      }
    }
  });
});
