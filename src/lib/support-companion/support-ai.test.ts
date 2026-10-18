import { describe, expect, it } from "vitest";
import {
  checkSupportAiAction,
  investigateDeterministic,
  supportModelFor,
} from "./support-ai";

describe("Support AI permission intersection (issue #984)", () => {
  const base = {
    operatorCaps: ["support.reports.read", "support.diagnostics.request"] as const,
    requiredCaps: ["support.reports.read"] as const,
    ticketScopeOk: true,
    authorizationOk: true,
    recipePolicyOk: true,
    consentOk: true,
  };

  it("allows only when every conjunct holds", () => {
    expect(checkSupportAiAction({ ...base })).toEqual({ allowed: true, reasons: [] });
  });

  it("names each failing conjunct instead of failing silently", () => {
    expect(
      checkSupportAiAction({ ...base, requiredCaps: ["support.repair.execute"] }),
    ).toEqual({ allowed: false, reasons: ["missing_capability:support.repair.execute"] });
    expect(checkSupportAiAction({ ...base, ticketScopeOk: false }).reasons).toContain("scope_mismatch");
    expect(checkSupportAiAction({ ...base, authorizationOk: false }).reasons).toContain(
      "authorization_missing",
    );
    expect(checkSupportAiAction({ ...base, recipePolicyOk: false }).reasons).toContain(
      "recipe_policy_failed",
    );
    expect(checkSupportAiAction({ ...base, consentOk: false }).reasons).toContain("consent_missing");
  });

  it("accumulates every failure so one bypass can never hide another", () => {
    const verdict = checkSupportAiAction({
      operatorCaps: [],
      requiredCaps: ["support.assist.control"],
      ticketScopeOk: false,
      authorizationOk: false,
      recipePolicyOk: false,
      consentOk: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons).toHaveLength(5);
  });
});

describe("Support AI deterministic investigation (issue #984)", () => {
  it("reports no-run state honestly instead of fabricating findings", () => {
    const summary = investigateDeterministic({ ticketId: "ticket-1", runs: [], repairs: [] });
    expect(summary).toContain("هیچ بررسی تشخیصی ثبت نشده");
  });

  it("summarizes runs and repairs with verification state", () => {
    const summary = investigateDeterministic({
      ticketId: "ticket-1",
      runs: [
        {
          id: "run-1",
          state: "partial",
          severity: "warning",
          observedAt: null,
          findings: [{ code: "DISK_LOW", title: "کمبود فضا" }, "رشته خام"],
        },
      ],
      repairs: [
        { id: "rep-1", recipeId: "main.restart_backend@2", state: "succeeded", verification: { verified: true } },
        { id: "rep-2", recipeId: "main.retry_sync_event@1", state: "failed", verification: {} },
      ],
    });
    expect(summary).toContain("DISK_LOW");
    expect(summary).toContain("main.restart_backend@2");
    expect(summary).toContain("تأییدشده");
    expect(summary).toContain("بدون راستی‌آزمایی موفق");
  });
});

describe("Support AI model profiles (issue #984)", () => {
  it("resolves through the platform model (LiteLLM owns deployments)", () => {
    expect(supportModelFor("support-default", "platform-chat")).toBe("platform-chat");
    expect(supportModelFor("support-research", "platform-chat")).toBe("platform-chat");
  });
});
