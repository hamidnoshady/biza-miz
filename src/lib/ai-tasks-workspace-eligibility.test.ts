import { describe, expect, it } from "vitest";
import { resolveAccessibleFocuses, resolveTenantTaskFeatures } from "@/lib/ai-tasks";

/**
 * Issue #1110 — the assistant's tenant feature map and app-focus catalogue must
 * follow the resolved Workspace availability, not only the raw feature flag.
 */
describe("assistant task features follow Workspace availability", () => {
  it("marks workspace false when the area is unavailable", () => {
    const features = resolveTenantTaskFeatures(
      { workspace: true },
      { industry: "architecture_construction", workspaceAvailable: false },
    );
    expect(features.workspace).toBe(false);
    expect(resolveAccessibleFocuses({
      permissions: ["workspace.view"],
      industry: "architecture_construction",
      features,
    })).not.toContain("workspace");
  });

  it("keeps workspace true for an eligible business with the flag on", () => {
    const features = resolveTenantTaskFeatures(
      { workspace: true },
      { industry: "architecture_construction", workspaceAvailable: true },
    );
    expect(features.workspace).toBe(true);
    expect(resolveAccessibleFocuses({
      permissions: ["workspace.view"],
      industry: "architecture_construction",
      features,
    })).toContain("workspace");
  });

  it("preserves the other apps and focuses when Workspace is hidden", () => {
    const features = resolveTenantTaskFeatures(
      { workspace: true },
      { industry: "food_service", workspaceAvailable: false },
    );
    const focuses = resolveAccessibleFocuses({
      permissions: ["workspace.view", "ledger.view", "crm.view", "reports.view"],
      industry: "food_service",
      features,
    });
    expect(focuses).not.toContain("workspace");
    expect(focuses).toContain("all");
    expect(focuses).toContain("accounting");
    expect(focuses).toContain("crm");
  });
});
