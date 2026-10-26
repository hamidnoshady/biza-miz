import { describe, expect, it } from "vitest";
import { APP_KEYS } from "../apps";
import { meterByKey } from "../billing/catalog/meters";
import {
  APP_SERVICE_DEFINITIONS,
  NO_AUTO_DELETE_POLICY,
  PROTECTED_PURGE_ENTRIES,
  RETENTION_MAX_DAYS,
  SECONDS_PER_HOUR,
  SERVICE_STATES,
  SERVICE_STATE_META,
  SERVICE_KINDS,
  STATIC_SERVICE_DEFINITIONS,
  SUSPENSION_STATE,
  WORKSPACE_SERVICE_DEFINITIONS,
  billableSecondsBetween,
  enabledRialForSeconds,
  firstHourRial,
  firstIntervalReserveRial,
  isServiceKey,
  isServiceKind,
  normalizeRetentionPolicy,
  purgeBlockReason,
  purgeManifestFor,
  purgePlanStatus,
  quoteServiceActivation,
  retentionDeadline,
  retentionWarningAt,
  rialToToman,
  serviceCatalogue,
  serviceIdentityKey,
  setupFeeRial,
  type ServiceTariff,
} from "./catalog";

const tariff = (overrides: Partial<ServiceTariff> = {}): ServiceTariff => ({
  version: 1,
  setupMode: "fixed",
  setupFixedRial: 0,
  setupEquivalentHours: 0,
  hourlyRateRial: 0,
  published: true,
  ...overrides,
});

describe("service registry", () => {
  it("bills exactly the four registered apps and no invented fifth", () => {
    expect(APP_SERVICE_DEFINITIONS.map((row) => row.key).sort()).toEqual([...APP_KEYS].sort());
    expect(APP_SERVICE_DEFINITIONS.every((row) => row.kind === "app")).toBe(true);
  });

  it("prices My Workspace capabilities, never the shell itself", () => {
    const keys = WORKSPACE_SERVICE_DEFINITIONS.map((row) => row.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain("shell");
    expect(keys).not.toContain("dashboard");
    expect(keys).not.toContain("billing");
    for (const definition of WORKSPACE_SERVICE_DEFINITIONS) {
      expect(isServiceKey("workspace", definition.key)).toBe(true);
    }
  });

  it("rejects unknown keys so a typo cannot create a priced service", () => {
    expect(isServiceKey("app", "accounting")).toBe(true);
    expect(isServiceKey("app", "pos")).toBe(false);
    expect(isServiceKey("app", "accounting")).toBe(true);
    expect(isServiceKey("workspace", "nope")).toBe(false);
    expect(isServiceKey("agent", "inventory-watch")).toBe(true);
    expect(isServiceKey("agent", "  ")).toBe(false);
    expect(isServiceKind("section")).toBe(false);
    expect(SERVICE_KINDS).toEqual(["app", "workspace", "agent"]);
  });

  it("makes a runtime instance part of the stable identity", () => {
    expect(serviceIdentityKey({ kind: "app", key: "crm" })).toBe("app:crm");
    expect(serviceIdentityKey({ kind: "agent", key: "watch", runtimeInstanceId: "b1" })).toBe(
      "agent:watch#b1",
    );
    expect(
      serviceIdentityKey({ kind: "agent", key: "watch", runtimeInstanceId: "  " }),
    ).toBe("agent:watch");
  });

  it("keeps the static registry free of duplicates", () => {
    const identities = STATIC_SERVICE_DEFINITIONS.map((row) => `${row.kind}:${row.key}`);
    expect(new Set(identities).size).toBe(identities.length);
  });
});

describe("setup fee", () => {
  it("charges the fixed Rial amount exactly", () => {
    expect(setupFeeRial(tariff({ setupMode: "fixed", setupFixedRial: 1_500_000 }))).toBe(1_500_000);
  });

  it("charges N hours at the hourly tariff for an hour-equivalent setup", () => {
    // The issue's example: 72 hours (3 days) at 120,000 Rial/hour.
    expect(
      setupFeeRial(
        tariff({
          setupMode: "hour_equivalent",
          setupEquivalentHours: 72,
          hourlyRateRial: 120_000,
        }),
      ),
    ).toBe(8_640_000);
  });

  it("handles fractional equivalent hours deterministically", () => {
    expect(
      setupFeeRial(
        tariff({
          setupMode: "hour_equivalent",
          setupEquivalentHours: 2.5,
          hourlyRateRial: 100_000,
        }),
      ),
    ).toBe(250_000);
    // 0.3333 hour is stored to the hundredth: 33 × 100 / 100 = 33 Rial.
    expect(
      setupFeeRial(
        tariff({
          setupMode: "hour_equivalent",
          setupEquivalentHours: 0.3333,
          hourlyRateRial: 100,
        }),
      ),
    ).toBe(33);
  });

  it("allows an explicitly published free setup", () => {
    expect(setupFeeRial(tariff({ setupMode: "fixed", setupFixedRial: 0 }))).toBe(0);
    expect(
      setupFeeRial(
        tariff({ setupMode: "hour_equivalent", setupEquivalentHours: 72, hourlyRateRial: 0 }),
      ),
    ).toBe(0);
  });
});

describe("enabled time", () => {
  it("prices 1h20m as exactly 80 minutes", () => {
    expect(billableSecondsBetween("2026-10-01T10:00:00.000Z", "2026-10-01T11:20:00.000Z")).toBe(4800);
    expect(enabledRialForSeconds(4800, 360_000)).toBe(480_000);
  });

  it("prorates by the second and rounds up once", () => {
    expect(enabledRialForSeconds(1, 360_000)).toBe(100);
    expect(enabledRialForSeconds(59, 360_000)).toBe(5_900);
    expect(enabledRialForSeconds(SECONDS_PER_HOUR, 123_456)).toBe(123_456);
    expect(enabledRialForSeconds(1, 1)).toBe(1); // 1/3600 Rial rounds up to 1
  });

  it("never charges for zero seconds, a zero tariff, or reversed instants", () => {
    expect(enabledRialForSeconds(0, 360_000)).toBe(0);
    expect(enabledRialForSeconds(4800, 0)).toBe(0);
    expect(billableSecondsBetween("2026-10-01T11:00:00.000Z", "2026-10-01T10:00:00.000Z")).toBe(0);
  });

  it("requires the setup fee plus one enabled hour to start", () => {
    const t = tariff({ setupMode: "fixed", setupFixedRial: 500_000, hourlyRateRial: 120_000 });
    expect(firstHourRial(t)).toBe(120_000);
    expect(firstIntervalReserveRial(t)).toBe(620_000);
  });

  it("rejects malformed input rather than guessing", () => {
    expect(() => enabledRialForSeconds(-1, 100)).toThrow("invalid_seconds");
    expect(() => enabledRialForSeconds(60, -100)).not.toThrow();
    expect(() =>
      setupFeeRial(tariff({ setupMode: "hour_equivalent", setupEquivalentHours: -1 })),
    ).toThrow("invalid_hours");
  });

  it("converts Rial to Toman for display", () => {
    expect(rialToToman(12_345)).toBe(1_234);
    expect(rialToToman(-5)).toBe(0);
  });
});

describe("activation quote", () => {
  const t = tariff({
    version: 4,
    setupMode: "hour_equivalent",
    setupEquivalentHours: 24,
    hourlyRateRial: 100_000,
  });

  it("fails closed when no tariff is published", () => {
    const quote = quoteServiceActivation({
      identity: { kind: "agent", key: "unpriced" },
      tariff: null,
      walletBalanceRial: 10_000_000,
    });
    expect(quote.eligible).toBe(false);
    expect(quote.reason).toBe("not_configured");
    expect(quote.setupRial).toBe(0);
    expect(quote.reserveRial).toBe(0);

    const unpublished = quoteServiceActivation({
      identity: { kind: "app", key: "crm" },
      tariff: { ...t, published: false },
      walletBalanceRial: 10_000_000,
    });
    expect(unpublished.reason).toBe("not_configured");
    expect(unpublished.eligible).toBe(false);
  });

  it("quotes the setup debit, hourly tariff, reserve and estimates", () => {
    const quote = quoteServiceActivation({
      identity: { kind: "app", key: "crm" },
      tariff: t,
      walletBalanceRial: 5_000_000,
    });
    expect(quote.eligible).toBe(true);
    expect(quote.reason).toBe("ready");
    expect(quote.setupRial).toBe(2_400_000); // 24h × 100,000
    expect(quote.hourlyRial).toBe(100_000);
    expect(quote.firstHourRial).toBe(100_000);
    expect(quote.reserveRial).toBe(2_500_000);
    expect(quote.estimated24hRial).toBe(2_400_000);
    expect(quote.estimated30dRial).toBe(72_000_000);
    expect(quote.balanceAfterSetupRial).toBe(2_600_000);
    expect(quote.additionalCharges.length).toBeGreaterThan(0);
  });

  it("refuses to start when the wallet cannot cover the reserve", () => {
    const quote = quoteServiceActivation({
      identity: { kind: "app", key: "crm" },
      tariff: t,
      walletBalanceRial: 2_499_999,
    });
    expect(quote.eligible).toBe(false);
    expect(quote.reason).toBe("insufficient_credit");
    expect(quote.reserveRial).toBe(2_500_000);
  });
});

describe("retention policy", () => {
  it("defaults to keeping everything", () => {
    expect(NO_AUTO_DELETE_POLICY.autoPurgeEnabled).toBe(false);
    expect(NO_AUTO_DELETE_POLICY.retentionDays).toBeNull();
    expect(
      retentionDeadline("2026-10-01T00:00:00.000Z", NO_AUTO_DELETE_POLICY),
    ).toBeNull();
  });

  it("supports the 7/30/90/365-day presets and an explicit indefinite choice", () => {
    for (const days of [7, 30, 90, 365]) {
      const policy = normalizeRetentionPolicy({ autoPurgeEnabled: true, retentionDays: days });
      expect(policy.retentionDays).toBe(days);
      expect(retentionDeadline("2026-10-01T00:00:00.000Z", policy)).toBe(
        new Date(Date.parse("2026-10-01T00:00:00.000Z") + days * 86_400_000).toISOString(),
      );
    }
    const indefinite = normalizeRetentionPolicy({
      autoPurgeEnabled: false,
      retentionDays: null,
    });
    expect(indefinite.autoPurgeEnabled).toBe(false);
    expect(indefinite.retentionDays).toBeNull();
  });

  it("rejects an out-of-range window instead of silently clamping it", () => {
    expect(() => normalizeRetentionPolicy({ autoPurgeEnabled: true, retentionDays: 0 })).toThrow(
      "invalid_retention_days",
    );
    expect(() =>
      normalizeRetentionPolicy({ autoPurgeEnabled: true, retentionDays: RETENTION_MAX_DAYS + 1 }),
    ).toThrow("invalid_retention_days");
  });

  it("refuses automatic purge without a finite window", () => {
    expect(() => normalizeRetentionPolicy({ autoPurgeEnabled: true, retentionDays: null })).toThrow(
      "indefinite_requires_disabled_purge",
    );
  });

  it("computes the warning instant from the lead time", () => {
    const policy = normalizeRetentionPolicy({
      autoPurgeEnabled: true,
      retentionDays: 30,
      notificationLeadDays: 7,
    });
    expect(retentionWarningAt("2026-10-31T00:00:00.000Z", policy)).toBe(
      "2026-10-24T00:00:00.000Z",
    );
  });
});

describe("purge eligibility", () => {
  const now = "2026-10-24T00:00:00.000Z";

  it("never purges a running, suspended or held service", () => {
    expect(
      purgeBlockReason({ state: "active", retentionDeadline: now, nowIso: now }),
    ).toBe("not_disabled");
    expect(
      purgeBlockReason({
        state: "suspended_insufficient_credit",
        retentionDeadline: now,
        nowIso: now,
      }),
    ).toBe("not_disabled");
    expect(
      purgeBlockReason({ state: "legal_hold", retentionDeadline: now, nowIso: now }),
    ).toBe("legal_hold");
    expect(
      purgeBlockReason({
        state: "disabled_retained",
        retentionDeadline: "2026-10-30T00:00:00.000Z",
        nowIso: now,
        legalHold: true,
      }),
    ).toBe("legal_hold");
  });

  it("waits for a real deadline and an actual expiry", () => {
    expect(
      purgeBlockReason({ state: "disabled_retained", retentionDeadline: null, nowIso: now }),
    ).toBe("no_deadline");
    expect(
      purgeBlockReason({
        state: "disabled_retained",
        retentionDeadline: "2026-10-30T00:00:00.000Z",
        nowIso: now,
      }),
    ).toBe("not_due");
    expect(
      purgeBlockReason({ state: "data_purged", retentionDeadline: now, nowIso: now }),
    ).toBe("already_purged");
  });

  it("allows the sweep exactly when a customer disable's deadline has passed", () => {
    expect(
      purgeBlockReason({
        state: "disabled_retained",
        retentionDeadline: "2026-10-20T00:00:00.000Z",
        nowIso: now,
      }),
    ).toBeNull();
    expect(
      purgeBlockReason({
        state: "eligible_for_purge",
        retentionDeadline: "2026-10-24T00:00:00.000Z",
        nowIso: now,
      }),
    ).toBeNull();
  });
});

describe("state vocabulary", () => {
  it("bills only the active state", () => {
    const billable = SERVICE_STATES.filter((state) => SERVICE_STATE_META[state].billable);
    expect(billable).toEqual(["active"]);
  });

  it("starts a retention countdown only for a customer disable", () => {
    const disabling = SERVICE_STATES.filter((state) => SERVICE_STATE_META[state].customerDisabled);
    expect(disabling).toEqual([
      "disabled_retained",
      "eligible_for_purge",
      "purging",
      "data_purged",
      "purge_failed",
    ]);
    expect(SERVICE_STATE_META.suspended_insufficient_credit.customerDisabled).toBe(false);
    expect(SERVICE_STATE_META.platform_unavailable.customerDisabled).toBe(false);
    expect(SERVICE_STATE_META.legal_hold.customerDisabled).toBe(false);
  });

  it("maps every suspension reason to a non-disable state", () => {
    for (const reason of Object.keys(SUSPENSION_STATE) as (keyof typeof SUSPENSION_STATE)[]) {
      const state = SUSPENSION_STATE[reason];
      expect(SERVICE_STATE_META[state].customerDisabled).toBe(false);
      expect(state).not.toBe("disabled_retained");
    }
  });

  it("stops claiming data exists once it has been purged", () => {
    expect(SERVICE_STATE_META.data_purged.retainsData).toBe(false);
    expect(SERVICE_STATE_META.disabled_retained.retainsData).toBe(true);
  });
});

describe("purge manifest", () => {
  it("limits non-CRM deletion to wizard state and permits only the reviewed CRM-owned tables", () => {
    for (const kind of SERVICE_KINDS) {
      const deletable = purgeManifestFor(kind).filter((entry) => entry.action === "delete");
      expect(deletable.map((entry) => entry.dataset)).toEqual(["service.wizard_state"]);
      expect(deletable.every((entry) => entry.classification === "owned")).toBe(true);
    }
    const crmDeletable = purgeManifestFor("app", "crm")
      .filter((entry) => entry.action === "delete")
      .map((entry) => entry.dataset);
    expect(crmDeletable).toEqual([
      "service.wizard_state",
      "crm.activities",
      "crm.deal_stage_history",
      "crm.custom_field_values_for_leads_and_deals",
      "crm.automotive_lead_preferences",
      "crm.automotive_lead_vehicle_links",
      "crm.deals",
      "crm.leads",
      "crm.pipeline_stages",
      "crm.pipelines",
      "crm.saved_views",
      "crm.scoring_state",
      "crm.automations",
    ]);
  });

  it("always preserves the commercial and financial evidence", () => {
    for (const kind of SERVICE_KINDS) {
      const datasets = purgeManifestFor(kind).map((entry) => entry.dataset);
      for (const entry of PROTECTED_PURGE_ENTRIES) {
        expect(datasets).toContain(entry.dataset);
      }
      const manifest = purgeManifestFor(kind);
      for (const dataset of ["service.activation_record", "wallet.ledger", "billing.usage_events"]) {
        expect(manifest.find((entry) => entry.dataset === dataset)?.action).toBe("preserve");
      }
    }
  });

  it("preserves CRM legal, consent, identity and run history while blocking shared CRM records", () => {
    const manifest = purgeManifestFor("app", "crm");
    for (const dataset of ["crm.audit_consent_merge_history", "crm.automation_run_history"]) {
      expect(manifest.find((entry) => entry.dataset === dataset)?.action).toBe("preserve");
    }
    for (const dataset of [
      "crm.cases_and_case_events",
      "crm.deals_linked_to_ledger_or_workspace",
      "crm.converted_or_externally_linked_leads",
      "crm.activities_attached_to_protected_records",
      "crm.pipelines_referenced_by_protected_deals",
      "crm.canonical_party_and_customer_data",
      "crm.external_profiles",
      "crm.cross_app_campaign_data",
      "crm.custom_field_definitions_and_protected_values",
    ]) {
      expect(manifest.find((entry) => entry.dataset === dataset)?.action).toBe("block");
    }
    expect(purgePlanStatus(manifest)).toBe("partial");
  });

  it("blocks shared and external datasets until ownership is reviewed", () => {
    for (const kind of SERVICE_KINDS) {
      const manifest = purgeManifestFor(kind);
      expect(manifest.some((entry) => entry.action === "block")).toBe(true);
      expect(purgePlanStatus(manifest)).toBe("partial");
      expect(
        manifest
          .filter((entry) => entry.action === "block")
          .every((entry) => entry.classification !== "owned"),
      ).toBe(true);
    }
  });
});

describe("declared meters", () => {
  it("registers both service meters in the canonical catalogue", () => {
    expect(meterByKey("service.setup")?.unit).toBe("activation");
    expect(meterByKey("service.enabled_seconds")?.unit).toBe("second");
    expect(meterByKey("service.enabled_seconds")?.aggregation).toBe("duration");
  });
});

describe("the console catalogue (issue #1041 §E.1)", () => {
  it("lists a published agent that has no tariff yet", () => {
    // The chicken-and-egg the merge exists for: a brand-new published agent
    // must be selectable so its FIRST tariff can be published. Before this it
    // was only listed once a price row existed, so it could never get one.
    const rows = serviceCatalogue({
      publishedAgents: [{ key: "watch-keeper", label: "نگهبان ساعت" }],
    });
    const agent = rows.find((row) => row.kind === "agent" && row.key === "watch-keeper");
    expect(agent).toMatchObject({ key: "watch-keeper", label: "نگهبان ساعت" });
  });

  it("keeps every static app and workspace capability, once each", () => {
    const rows = serviceCatalogue({
      publishedAgents: [
        { key: "Bad Key", label: "not a valid agent key" }, // dropped
        { key: "a1", label: null },
        { key: "a1", label: "dup" },
      ],
      pricedAgentKeys: ["a1", "a2", "Bad Key"],
    });
    expect(rows.filter((row) => row.kind === "app").map((row) => row.key)).toEqual(
      APP_SERVICE_DEFINITIONS.map((row) => row.key),
    );
    expect(rows.filter((row) => row.kind === "workspace")).toHaveLength(
      WORKSPACE_SERVICE_DEFINITIONS.length,
    );
    // One entry per agent identity: a published agent that also carries a price
    // version is not listed twice.
    const agents = rows.filter((row) => row.kind === "agent").map((row) => row.key);
    expect(agents).toEqual(["a1", "a2"]);
    // `agent:crm` and `app:crm` are different service identities, so an agent
    // that happens to share an app's key is not silently merged into it.
    expect(
      serviceCatalogue({ publishedAgents: [{ key: "crm", label: "CRM agent" }] })
        .filter((row) => row.key === "crm")
        .map((row) => row.kind),
    ).toEqual(["app", "agent"]);
    // A missing label falls back to the key rather than rendering blank.
    expect(rows.find((row) => row.key === "a1")?.label).toBe("a1");
  });
});
