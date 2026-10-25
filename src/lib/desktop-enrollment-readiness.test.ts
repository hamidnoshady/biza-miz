import { describe, expect, it } from "vitest";
import { STEPS } from "@/app/setup/steps";
import {
  evaluateEnrollmentReadiness,
  setupStepHref,
  type EnrollmentFacts,
} from "./desktop-enrollment-readiness";
import { LEGACY_PAIRING_SNAPSHOT_VERSION, PAIRING_SNAPSHOT_VERSION } from "./pairing-snapshot";
import { setupReadiness } from "./setup-readiness";

const BRANCH = { id: "11111111-1111-4111-8111-111111111111", name: "مرکزی" };
const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "شعبهٔ دو" };

function readySetup() {
  return setupReadiness({
    industry: "food_service",
    hasBusiness: true,
    hasLocation: true,
    hasPrefs: true,
    hasCosting: true,
    hasTax: true,
    accounts: 40,
    sellableMenuItems: 12,
  });
}

function facts(overrides: Partial<EnrollmentFacts> = {}): EnrollmentFacts {
  return {
    business: { exists: true, status: "active" },
    setup: readySetup(),
    setupCompletedAt: "2026-10-01T08:00:00.000Z",
    activeOwners: 1,
    activeLocations: [BRANCH],
    requestedLocationId: null,
    sellableMenuItemsByLocation: { [BRANCH.id]: 12 },
    activePaymentWays: 3,
    siteCloudSyncEntitled: true,
    clientMaxSnapshotVersion: null,
    ...overrides,
  };
}

describe("evaluateEnrollmentReadiness", () => {
  it("is ready for a finished single-branch business and picks that branch", () => {
    const result = evaluateEnrollmentReadiness(facts());
    expect(result.ready).toBe(true);
    expect(result.locationId).toBe(BRANCH.id);
    expect(result.blockers).toEqual([]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  describe("partial setup", () => {
    it("names every missing required step and points at the first one", () => {
      const partial = setupReadiness({
        industry: "food_service",
        hasBusiness: true,
        hasLocation: true,
        hasPrefs: true,
        hasCosting: false,
        hasTax: false,
        accounts: 0,
        sellableMenuItems: 0,
      });
      const result = evaluateEnrollmentReadiness(
        facts({ setup: partial, setupCompletedAt: null, sellableMenuItemsByLocation: {} }),
      );
      expect(result.ready).toBe(false);
      const blocker = result.blockers.find((entry) => entry.code === "setup_incomplete");
      expect(blocker?.missingSteps).toEqual(["accounts", "costing", "tax", "menu"]);
      expect(blocker?.action).toEqual({ kind: "open_cloud_setup", href: "/setup/accounts" });
      // A business that is not ready is not told to "finish" what it has not done.
      expect(result.blockerCodes).not.toContain("setup_not_completed");
    });

    it("distinguishes ready-but-unfinished from incomplete", () => {
      const result = evaluateEnrollmentReadiness(facts({ setupCompletedAt: null }));
      expect(result.blockerCodes).toEqual(["setup_not_completed"]);
      expect(result.blockers[0].action).toEqual({ kind: "open_cloud_setup", href: "/setup/finish" });
    });

    it("does not require optional steps", () => {
      // Hardware, backup and opening are not in the required set, so a business
      // that never touched them is still ready.
      expect(Object.keys(readySetup().steps)).not.toContain("hardware");
      expect(evaluateEnrollmentReadiness(facts()).ready).toBe(true);
    });

    it("applies the industry's own required steps (no menu for a service company)", () => {
      const service = setupReadiness({
        industry: "service_saas",
        hasBusiness: true,
        hasLocation: true,
        hasPrefs: true,
        hasCosting: false,
        hasTax: true,
        accounts: 20,
        sellableMenuItems: 0,
      });
      const result = evaluateEnrollmentReadiness(facts({ setup: service, sellableMenuItemsByLocation: null }));
      expect(result.ready).toBe(true);
    });
  });

  describe("account state", () => {
    it("refuses a suspended business, with support as the only way out", () => {
      const result = evaluateEnrollmentReadiness(facts({ business: { exists: true, status: "suspended" } }));
      expect(result.blockerCodes).toEqual(["business_suspended"]);
      expect(result.blockers[0].action).toEqual({ kind: "contact_support" });
    });

    it("refuses an archived business", () => {
      expect(
        evaluateEnrollmentReadiness(facts({ business: { exists: true, status: "archived" } })).blockerCodes,
      ).toEqual(["business_archived"]);
    });

    it("stops at once for a business that does not exist", () => {
      const result = evaluateEnrollmentReadiness(facts({ business: { exists: false, status: null } }));
      expect(result.blockerCodes).toEqual(["business_not_found"]);
      expect(result.locationId).toBeNull();
    });

    it("refuses a business with no active owner (a revoked or deactivated owner)", () => {
      expect(evaluateEnrollmentReadiness(facts({ activeOwners: 0 })).blockerCodes).toEqual(["no_active_owner"]);
    });

    it("refuses a business that is not entitled to desktop sync", () => {
      expect(evaluateEnrollmentReadiness(facts({ siteCloudSyncEntitled: false })).blockerCodes).toEqual([
        "not_entitled",
      ]);
    });

    it("reports every account-level problem together rather than one at a time", () => {
      const result = evaluateEnrollmentReadiness(
        facts({ business: { exists: true, status: "suspended" }, activeOwners: 0, siteCloudSyncEntitled: false }),
      );
      expect(result.blockerCodes).toEqual(["business_suspended", "no_active_owner", "not_entitled"]);
    });
  });

  describe("branches", () => {
    const two = { activeLocations: [BRANCH, OTHER], sellableMenuItemsByLocation: { [BRANCH.id]: 5, [OTHER.id]: 0 } };

    it("asks for a choice when there are several branches and none was named", () => {
      const result = evaluateEnrollmentReadiness(facts(two));
      expect(result.blockerCodes).toEqual(["location_required"]);
      expect(result.blockers[0].action).toEqual({ kind: "choose_location", locations: [BRANCH, OTHER] });
      expect(result.locationId).toBeNull();
    });

    it("enrols at the named branch", () => {
      const result = evaluateEnrollmentReadiness(facts({ ...two, requestedLocationId: BRANCH.id }));
      expect(result.ready).toBe(true);
      expect(result.locationId).toBe(BRANCH.id);
    });

    it("refuses a branch that is inactive or belongs to nobody here", () => {
      const result = evaluateEnrollmentReadiness(
        facts({ ...two, requestedLocationId: "33333333-3333-4333-8333-333333333333" }),
      );
      expect(result.blockerCodes).toEqual(["location_unavailable"]);
    });

    it("judges the menu at the chosen branch, not across the business", () => {
      // The business has 5 sellable items in total, none at branch two.
      const atEmpty = evaluateEnrollmentReadiness(facts({ ...two, requestedLocationId: OTHER.id }));
      expect(atEmpty.blockerCodes).toEqual(["branch_menu_empty"]);
      expect(atEmpty.blockers[0].action).toEqual({ kind: "open_cloud_setup", href: "/setup/menu" });
    });

    it("refuses a business with no active branch", () => {
      const result = evaluateEnrollmentReadiness(facts({ activeLocations: [], sellableMenuItemsByLocation: {} }));
      expect(result.blockerCodes).toContain("no_active_location");
    });
  });

  it("requires at least one active payment way", () => {
    const result = evaluateEnrollmentReadiness(facts({ activePaymentWays: 0 }));
    expect(result.blockerCodes).toEqual(["no_payment_way"]);
    expect(result.blockers[0].action).toEqual({ kind: "open_cloud_setup", href: "/settings/payment-methods" });
  });

  describe("protocol", () => {
    it("does not judge a client that did not say what it can read", () => {
      expect(evaluateEnrollmentReadiness(facts({ clientMaxSnapshotVersion: null })).ready).toBe(true);
    });

    it("accepts the legacy and current snapshot versions", () => {
      for (const version of [LEGACY_PAIRING_SNAPSHOT_VERSION, PAIRING_SNAPSHOT_VERSION]) {
        expect(evaluateEnrollmentReadiness(facts({ clientMaxSnapshotVersion: version })).ready).toBe(true);
      }
    });

    it("tells an older client to update", () => {
      const result = evaluateEnrollmentReadiness(
        facts({ clientMaxSnapshotVersion: LEGACY_PAIRING_SNAPSHOT_VERSION - 1 }),
      );
      expect(result.blockerCodes).toEqual(["client_outdated"]);
      expect(result.blockers[0].action).toEqual({ kind: "update_desktop" });
    });
  });

  it("returns stable, sorted, de-duplicated blocker codes so a client can resume by watching them", () => {
    const result = evaluateEnrollmentReadiness(facts({ activeOwners: 0, activePaymentWays: 0, siteCloudSyncEntitled: false }));
    expect(result.blockerCodes).toEqual([...result.blockerCodes].sort());
    expect(new Set(result.blockerCodes).size).toBe(result.blockerCodes.length);
  });

  it("gives every blocker a Persian message and a concrete action", () => {
    const result = evaluateEnrollmentReadiness(
      facts({
        business: { exists: true, status: "suspended" },
        activeOwners: 0,
        siteCloudSyncEntitled: false,
        activeLocations: [BRANCH, OTHER],
        setupCompletedAt: null,
        activePaymentWays: 0,
        clientMaxSnapshotVersion: 0,
      }),
    );
    expect(result.blockers.length).toBeGreaterThan(4);
    for (const blocker of result.blockers) {
      expect(blocker.message, blocker.code).toMatch(/[؀-ۿ]/);
      expect(blocker.action.kind, blocker.code).toBeTruthy();
    }
  });
});

describe("setupStepHref", () => {
  it("matches the wizard's own page for every step", () => {
    for (const step of STEPS) expect(setupStepHref(step.id), step.id).toBe(step.path);
  });
});
