/**
 * GitHub #1580 — the effective-import-access matrix.
 *
 * Every acceptance case in the issue is one row here: paid active,
 * complimentary time-limited, complimentary indefinite, selected-only,
 * expired/revoked grant, suspended/disabled service, industry, deployment,
 * permission and Workspace. The pure resolver is what the wizard route, the
 * Data Transfer engine and the job worker all call, so pinning it here covers
 * both UI and background enforcement.
 */
import { describe, expect, it } from "vitest";
import {
  IMPORT_BLOCKED_ACTIVATION_STATES,
  IMPORT_PENDING_ACTIVATION_STATES,
  IMPORT_SUSPENDED_ACTIVATION_STATES,
  activeGrantAt,
  resolveImportAccess,
  type ImportAccessInput,
} from "./import-access";
import { SERVICE_STATE_META } from "./service-activation/catalog";

const AT = "2026-11-27T12:00:00.000Z";

function input(overrides: Partial<ImportAccessInput> = {}): ImportAccessInput {
  return {
    appKey: "accounting",
    selection: ["accounting"],
    activationState: "active",
    grant: null,
    workspace: null,
    permitted: true,
    importable: true,
    at: AT,
    ...overrides,
  };
}

describe("resolveImportAccess — entity-level refusals", () => {
  it("refuses a type the platform cannot import, before anything else", () => {
    const decision = resolveImportAccess(
      input({ importable: false, permitted: false, activationState: null }),
    );
    expect(decision).toMatchObject({
      allowed: false,
      stagingAllowed: false,
      reason: "not_importable",
    });
  });

  it("refuses an industry without the module", () => {
    const decision = resolveImportAccess(input({ industryEligible: false }));
    expect(decision.reason).toBe("industry_module");
    expect(decision.stagingAllowed).toBe(false);
  });

  it("refuses a member without data.import or the entity key", () => {
    expect(resolveImportAccess(input({ permitted: false })).reason).toBe("permission");
  });

  it("refuses an app the owner did not select, and never offers staging", () => {
    const decision = resolveImportAccess(input({ selection: ["crm"] }));
    expect(decision.reason).toBe("app_not_selected");
    expect(decision.stagingAllowed).toBe(false);
  });
});

describe("resolveImportAccess — paid and complimentary access", () => {
  it("allows an active paid service", () => {
    expect(resolveImportAccess(input())).toMatchObject({
      allowed: true,
      stagingAllowed: true,
      source: "paid_active",
    });
  });

  it("allows an active time-limited complimentary grant without a paid plan", () => {
    const decision = resolveImportAccess(
      input({
        activationState: null,
        grant: {
          status: "active",
          startsAt: "2026-11-20T00:00:00.000Z",
          expiresAt: "2026-12-20T00:00:00.000Z",
        },
      }),
    );
    expect(decision).toMatchObject({ allowed: true, source: "complimentary_grant" });
  });

  it("allows an indefinite grant", () => {
    const decision = resolveImportAccess(
      input({
        activationState: null,
        grant: { status: "active", startsAt: "2026-01-01T00:00:00.000Z", expiresAt: null },
      }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("complimentary_grant");
  });

  it("denies an expired grant but keeps staging", () => {
    const decision = resolveImportAccess(
      input({
        activationState: null,
        grant: {
          status: "expired",
          startsAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-01T00:00:00.000Z",
        },
      }),
    );
    expect(decision).toMatchObject({ allowed: false, stagingAllowed: true, reason: "grant_inactive" });
  });

  it("denies a revoked grant", () => {
    const decision = resolveImportAccess(
      input({
        activationState: null,
        grant: { status: "revoked", startsAt: "2026-11-01T00:00:00.000Z", expiresAt: null },
      }),
    );
    expect(decision.reason).toBe("grant_inactive");
    expect(decision.allowed).toBe(false);
  });

  it("treats an active grant whose window already closed as inactive", () => {
    const decision = resolveImportAccess(
      input({
        activationState: null,
        grant: {
          status: "active",
          startsAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-01T00:00:00.000Z",
        },
      }),
    );
    expect(decision.reason).toBe("grant_inactive");
  });

  it("checks the grant window with the supplied instant, not the wall clock", () => {
    const grant = {
      status: "active" as const,
      startsAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    };
    expect(activeGrantAt(grant, "2026-11-15T00:00:00.000Z")).toBe(true);
    expect(activeGrantAt(grant, "2026-12-01T00:00:00.000Z")).toBe(false);
    expect(activeGrantAt(grant, "2026-10-31T23:59:59.000Z")).toBe(false);
    expect(activeGrantAt({ ...grant, expiresAt: null }, "2030-01-01T00:00:00.000Z")).toBe(true);
  });
});

describe("resolveImportAccess — selected but not active", () => {
  it("shows «منتظر فعال‌سازی» and allows only staging", () => {
    const decision = resolveImportAccess(input({ activationState: null, selection: ["accounting"] }));
    expect(decision).toMatchObject({
      allowed: false,
      stagingAllowed: true,
      reason: "awaiting_activation",
    });
    expect(decision.label).toContain("منتظر فعال‌سازی");
  });

  it("treats setup_in_progress and payment_reserved as awaiting activation", () => {
    for (const state of IMPORT_PENDING_ACTIVATION_STATES) {
      const decision = resolveImportAccess(input({ activationState: state }));
      expect(decision.reason, state).toBe("awaiting_activation");
      expect(decision.stagingAllowed, state).toBe(true);
    }
  });

  it("refuses a suspended service for writes but permits staging", () => {
    for (const state of IMPORT_SUSPENDED_ACTIVATION_STATES) {
      const decision = resolveImportAccess(input({ activationState: state }));
      expect(decision.reason, state).toBe("service_suspended");
      expect(decision.allowed, state).toBe(false);
      expect(decision.stagingAllowed, state).toBe(true);
    }
  });

  it("refuses a disabled/purged service with no staging at all", () => {
    for (const state of IMPORT_BLOCKED_ACTIVATION_STATES) {
      const decision = resolveImportAccess(input({ activationState: state }));
      expect(decision.reason, state).toBe("service_disabled");
      expect(decision.stagingAllowed, state).toBe(false);
    }
  });

  it("refuses an app the operator switched off", () => {
    const decision = resolveImportAccess(input({ deploymentSupported: false }));
    expect(decision.reason).toBe("app_unavailable");
    expect(decision.stagingAllowed).toBe(false);
  });
});

describe("resolveImportAccess — grandfathering", () => {
  it("keeps a pre-gallery tenant's historic access", () => {
    expect(
      resolveImportAccess(input({ selection: null, activationState: null })),
    ).toMatchObject({ allowed: true, source: "legacy_grandfathered" });
  });

  it("does not grandfather an explicit empty selection", () => {
    expect(
      resolveImportAccess(input({ selection: [], activationState: null })).reason,
    ).toBe("app_not_selected");
  });
});

describe("resolveImportAccess — My Workspace", () => {
  const workspace = { eligible: true, serviceEnabled: true, deploymentSupported: true };

  it("allows an eligible, enabled Workspace", () => {
    expect(
      resolveImportAccess(input({ appKey: null, selection: null, workspace, activationState: "active" })),
    ).toMatchObject({ allowed: true });
  });

  it("blocks an ineligible business type even though the shell may render", () => {
    const decision = resolveImportAccess(
      input({ appKey: null, workspace: { ...workspace, eligible: false } }),
    );
    expect(decision.reason).toBe("workspace_unavailable");
    expect(decision.stagingAllowed).toBe(false);
  });

  it("treats a disabled Workspace service as awaiting activation", () => {
    const decision = resolveImportAccess(
      input({ appKey: null, workspace: { ...workspace, serviceEnabled: false } }),
    );
    expect(decision.reason).toBe("awaiting_activation");
    expect(decision.allowed).toBe(false);
  });

  it("blocks a deployment that cannot run Workspace", () => {
    expect(
      resolveImportAccess(
        input({ appKey: null, workspace: { ...workspace, deploymentSupported: false } }),
      ).reason,
    ).toBe("deployment_unsupported");
  });

  it("is not an APP_KEY: a selection that omits it never matters", () => {
    const decision = resolveImportAccess(
      input({ appKey: null, selection: ["crm"], workspace, activationState: "active" }),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("activation state sets stay pinned to the canonical catalogue", () => {
  it("blocked states are exactly the customer-disabled ones", () => {
    for (const state of IMPORT_BLOCKED_ACTIVATION_STATES) {
      expect(SERVICE_STATE_META[state].customerDisabled, state).toBe(true);
    }
    for (const state of IMPORT_SUSPENDED_ACTIVATION_STATES) {
      expect(SERVICE_STATE_META[state].enabled, state).toBe(false);
      expect(SERVICE_STATE_META[state].customerDisabled, state).toBe(false);
      expect(SERVICE_STATE_META[state].retainsData, state).toBe(true);
    }
    for (const state of IMPORT_PENDING_ACTIVATION_STATES) {
      expect(SERVICE_STATE_META[state].enabled, state).toBe(false);
      expect(SERVICE_STATE_META[state].customerDisabled, state).toBe(false);
    }
  });
});
