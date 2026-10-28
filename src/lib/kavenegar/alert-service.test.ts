import { describe, expect, it } from "vitest";
import {
  ALERT_ACTION,
  ALERT_SEVERITY,
  ALERT_TITLE,
  alertForAccount,
  alertForFundingBlock,
  alertForProvisioningJob,
  alertForReconciliation,
  alertForTransferState,
  type ServiceAlertKind,
} from "./alert-service";
import type { FundingBlockedReason } from "./pricing-service";

const ALL_KINDS: ServiceAlertKind[] = [
  "master_credit_low",
  "master_balance_unknown",
  "fleet_cap_reached",
  "child_cap_reached",
  "daily_cap_reached",
  "unresolved_transfer",
  "funding_failed",
  "reconciliation_drift",
  "reconciliation_incomplete",
  "account_suspended",
  "provisioning_failed",
  "tariff_missing",
];

const BUSINESS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("alert copy is complete and provider-free", () => {
  it("has a severity, a title and a remedy for every kind", () => {
    for (const kind of ALL_KINDS) {
      expect(ALERT_SEVERITY[kind], kind).toBeTruthy();
      expect(ALERT_TITLE[kind], kind).toBeTruthy();
      expect(ALERT_ACTION[kind], kind).toBeTruthy();
    }
  });

  it("never names the supplier or a provider error code in operator copy", () => {
    // §0: the whole platform speaks first-party. These strings are shown to a
    // Superadmin, but the rule is about the product's voice, not the audience —
    // and a provider name in an alert is how it ends up in a screenshot pasted
    // into a tenant support ticket.
    for (const kind of ALL_KINDS) {
      const text = `${ALERT_TITLE[kind]} ${ALERT_ACTION[kind]}`.toLowerCase();
      expect(text).not.toContain("kavenegar");
      expect(text).not.toMatch(/\b(418|424|601|602|407)\b/);
      expect(text).not.toContain("api key");
    }
  });
});

describe("funding blocks become alerts only when a human must act", () => {
  it("treats a drained master account as critical and a missing figure as a warning", () => {
    expect(alertForFundingBlock("master_floor", null)).toMatchObject({
      kind: "master_credit_low",
      businessId: null,
    });
    expect(alertForFundingBlock("master_balance_unknown", null)).toMatchObject({
      kind: "master_balance_unknown",
      businessId: null,
    });
  });

  it("attributes a cap to the business, and the fleet cap to nobody", () => {
    expect(alertForFundingBlock("child_cap_reached", BUSINESS)).toMatchObject({
      kind: "child_cap_reached",
      businessId: BUSINESS,
    });
    expect(alertForFundingBlock("daily_cap_reached", BUSINESS)).toMatchObject({
      kind: "daily_cap_reached",
      businessId: BUSINESS,
    });
    expect(alertForFundingBlock("global_daily_cap_reached", BUSINESS)).toMatchObject({
      kind: "fleet_cap_reached",
      businessId: null,
    });
  });

  it("stays quiet for the operator's own settings and for rounding remainders", () => {
    const quiet: FundingBlockedReason[] = [
      "automatic_top_up_off",
      "outside_funding_window",
      "healthy",
      "below_provider_minimum",
    ];
    for (const reason of quiet) {
      expect(alertForFundingBlock(reason, BUSINESS), reason).toBeNull();
    }
  });

  it("stays quiet for an in-flight reservation, which is the double-funding guard working", () => {
    // An `unknown` OUTCOME is a different thing and does alert — see below.
    expect(alertForFundingBlock("unresolved_transfer", BUSINESS)).toBeNull();
  });

  it("asks for a tariff sync when the provider tariff is unknown", () => {
    expect(alertForFundingBlock("tariff_unknown", BUSINESS)).toMatchObject({ kind: "tariff_missing" });
  });
});

describe("transfer outcomes", () => {
  it("alerts critically on an unknown outcome, deduped per transfer", () => {
    expect(alertForTransferState("unknown", BUSINESS, "t-1")).toEqual({
      kind: "unresolved_transfer",
      businessId: BUSINESS,
      subjectKey: "t-1",
    });
  });

  it("alerts on a definite failure, and nothing on success or the reservation itself", () => {
    expect(alertForTransferState("failed", BUSINESS, "t-2")).toMatchObject({ kind: "funding_failed" });
    expect(alertForTransferState("applied", BUSINESS, "t-3")).toBeNull();
    expect(alertForTransferState("pending", BUSINESS, "t-4")).toBeNull();
  });
});

describe("reconciliation and account state", () => {
  it("separates drift (money) from an unreadable balance (a gap)", () => {
    expect(alertForReconciliation("drift", BUSINESS)).toMatchObject({ kind: "reconciliation_drift" });
    expect(alertForReconciliation("incomplete", BUSINESS)).toMatchObject({ kind: "reconciliation_incomplete" });
    expect(alertForReconciliation("ok", BUSINESS)).toBeNull();
  });

  it("alerts when our row says active and the provider disagrees", () => {
    for (const providerStatus of ["removed", "pending", "unknown", null]) {
      expect(
        alertForAccount({ businessId: BUSINESS, provisionState: "active", providerStatus }),
        String(providerStatus),
      ).toMatchObject({ kind: "account_suspended", businessId: BUSINESS });
    }
  });

  it("does not alert about a child we already know is not active", () => {
    expect(alertForAccount({ businessId: BUSINESS, provisionState: "active", providerStatus: "approved" })).toBeNull();
    for (const provisionState of ["suspended", "attention_required", "pending", "not_provisioned"]) {
      expect(
        alertForAccount({ businessId: BUSINESS, provisionState, providerStatus: "removed" }),
        provisionState,
      ).toBeNull();
    }
  });
});

describe("provisioning failures", () => {
  it("alerts only once the job will not be retried again", () => {
    expect(
      alertForProvisioningJob({ businessId: BUSINESS, state: "failed", attempts: 1, lastErrorCode: "bad_plan" }),
    ).toMatchObject({ kind: "provisioning_failed", detail: { attempts: 1, errorCode: "bad_plan" } });

    expect(
      alertForProvisioningJob({ businessId: BUSINESS, state: "retry_pending", attempts: 1, lastErrorCode: "timeout" }),
    ).toBeNull();

    // Out of attempts: the next pass will not rescue it, so a human must know.
    expect(
      alertForProvisioningJob({ businessId: BUSINESS, state: "retry_pending", attempts: 3, lastErrorCode: "timeout" }),
    ).toMatchObject({ kind: "provisioning_failed" });

    expect(
      alertForProvisioningJob({ businessId: BUSINESS, state: "succeeded", attempts: 1, lastErrorCode: null }),
    ).toBeNull();
  });
});
