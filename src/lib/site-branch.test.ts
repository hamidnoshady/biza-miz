/**
 * #1573 — a paired Hybrid / Full-Offline site is exactly one branch, and its
 * queue may only ever be pushed as that branch. `resolveSiteBranch` is the
 * pure half of the guard `runServerPush` now applies before anything leaves
 * the machine.
 */
import { describe, expect, it } from "vitest";
import { eventAllowedForSiteBranch, resolveSiteBranch } from "./site-branch";

const BRANCH = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("resolveSiteBranch", () => {
  it("leaves an unpaired, business-wide-token install alone", () => {
    expect(resolveSiteBranch({ locationId: BRANCH }, [BRANCH])).toEqual({ paired: false });
    expect(resolveSiteBranch(null, [])).toEqual({ paired: false });
  });

  it("resolves the branch pairing wrote into the sync config", () => {
    expect(resolveSiteBranch({ siteDeviceId: "device-1", locationId: BRANCH }, [OTHER, BRANCH]))
      .toEqual({ paired: true, ok: true, locationId: BRANCH });
  });

  it("fails closed when a paired site has no branch", () => {
    // The old behaviour treated this as "every local branch" and sent the whole
    // queue, which the cloud refused as site_location_mismatch.
    expect(resolveSiteBranch({ siteDeviceId: "device-1", locationId: null }, [BRANCH]))
      .toEqual({ paired: true, ok: false, reason: "branch_unresolved" });
    expect(resolveSiteBranch({ siteDeviceId: "device-1" }, [BRANCH]))
      .toEqual({ paired: true, ok: false, reason: "branch_unresolved" });
    expect(resolveSiteBranch({ siteDeviceId: "device-1", locationId: "   " }, [BRANCH]))
      .toEqual({ paired: true, ok: false, reason: "branch_unresolved" });
  });

  it("refuses a branch that does not exist on this machine", () => {
    expect(resolveSiteBranch({ siteDeviceId: "device-1", locationId: OTHER }, [BRANCH]))
      .toEqual({ paired: true, ok: false, reason: "branch_not_local" });
  });
});

describe("eventAllowedForSiteBranch", () => {
  it("lets only the paired branch's events be pushed", () => {
    const resolved = resolveSiteBranch({ siteDeviceId: "device-1", locationId: BRANCH }, [BRANCH, OTHER]);
    expect(eventAllowedForSiteBranch(resolved, BRANCH)).toBe(true);
    // A second branch's queued sale is never sent under this site's credential.
    expect(eventAllowedForSiteBranch(resolved, OTHER)).toBe(false);
  });

  it("lets nothing through while the branch is unresolved", () => {
    const unresolved = resolveSiteBranch({ siteDeviceId: "device-1", locationId: null }, [BRANCH]);
    expect(eventAllowedForSiteBranch(unresolved, BRANCH)).toBe(false);
  });

  it("does not constrain an install with no site pairing", () => {
    expect(eventAllowedForSiteBranch(resolveSiteBranch(null, []), BRANCH)).toBe(true);
  });
});
