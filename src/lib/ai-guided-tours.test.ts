import { describe, expect, it } from "vitest";
import { AI_GUIDED_TOURS, isAiGuideTarget, resolveAuthorizedAiGuide } from "./ai-guided-tours";
import type { AuthorizedAiDestination } from "./ai-navigation-search";

const crm: AuthorizedAiDestination = { id: "/crm/overview", href: "/crm/overview", label: "CRM" };
const ledger: AuthorizedAiDestination = { id: "/accounting/overview", href: "/accounting/overview", label: "حسابداری" };

describe("guided tours are tenant-allowlisted UI only", () => {
  it("refuses unknown guide IDs and arbitrary CSS selector targets", () => {
    expect(resolveAuthorizedAiGuide("__proto__", [crm, ledger])).toBeNull();
    expect(resolveAuthorizedAiGuide("<script>", [crm])).toBeNull();
    expect(isAiGuideTarget("body")).toBe(false);
    expect(isAiGuideTarget("app-crm")).toBe(true);
  });
  it("requires the underlying app destination to be authorized", () => {
    expect(resolveAuthorizedAiGuide("app-accounting", [crm])).toBeNull();
    expect(resolveAuthorizedAiGuide("app-crm", [crm])?.id).toBe("app-crm");
    expect(resolveAuthorizedAiGuide("app-accounting", [ledger])?.id).toBe("app-accounting");
  });
  it("allows only basic navigation guidance without an app permission", () => {
    expect(resolveAuthorizedAiGuide("assistant-basics", [])?.steps.length).toBe(2);
  });
  it("never embeds arbitrary selectors or raw URLs in tour steps", () => {
    for (const guide of AI_GUIDED_TOURS) {
      expect(guide.steps.length).toBeGreaterThan(0);
      for (const step of guide.steps) {
        expect(isAiGuideTarget(step.target)).toBe(true);
        expect(step.target).not.toContain("[");
        expect(step.explanation.length).toBeGreaterThan(10);
      }
    }
  });
});
