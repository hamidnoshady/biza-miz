import { beforeEach, describe, expect, it, vi } from "vitest";

const activation = vi.hoisted(() => ({ serviceActivationState: vi.fn() }));
vi.mock("./service-activation/app-gate-service", () => activation);

import { aiActionServiceForEndpoint, aiActionServiceGate } from "./ai-service-activation";

describe("activation gates for background AI actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activation.serviceActivationState.mockResolvedValue(null);
  });

  it("maps app and Workspace actions from their canonical endpoints", () => {
    expect(aiActionServiceForEndpoint("/api/crm/deals")).toEqual({ kind: "app", key: "crm" });
    expect(aiActionServiceForEndpoint("/api/cms/website/drafts")).toEqual({ kind: "app", key: "website" });
    expect(aiActionServiceForEndpoint("/api/messaging/campaigns")).toEqual({ kind: "app", key: "growth" });
    expect(aiActionServiceForEndpoint("/api/workspace/documents/123")).toEqual({ kind: "workspace", key: "documents" });
    expect(aiActionServiceForEndpoint("/api/workspace/projects/123/tasks")).toEqual({ kind: "workspace", key: "projects" });
    expect(aiActionServiceForEndpoint("/api/aec/contracts/123/commercial")).toEqual({ kind: "workspace", key: "projects" });
    expect(aiActionServiceForEndpoint("/api/notifications")).toBeNull();
  });

  it("blocks an action only for a customer-disabled service", async () => {
    activation.serviceActivationState.mockResolvedValue("disabled_retained");
    await expect(aiActionServiceGate("business-1", "crm.deal.save")).resolves.toMatchObject({
      allowed: false,
      error: "service_disabled",
      service: { kind: "app", key: "crm" },
      state: "disabled_retained",
    });
  });

  it("does not treat suspension or legal hold as customer disable", async () => {
    for (const state of ["suspended_insufficient_credit", "platform_unavailable", "legal_hold"]) {
      activation.serviceActivationState.mockResolvedValue(state);
      await expect(aiActionServiceGate("business-1", "crm.deal.save")).resolves.toMatchObject({ allowed: true });
    }
  });

  it("keeps shared shell actions outside app activation and fails closed on lookup errors", async () => {
    await expect(aiActionServiceGate("business-1", "project.task.add")).resolves.toMatchObject({ allowed: true });
    activation.serviceActivationState.mockRejectedValue(new Error("database unavailable"));
    await expect(aiActionServiceGate("business-1", "crm.deal.save")).resolves.toMatchObject({
      allowed: false,
      error: "service_activation_check_unavailable",
    });
  });
});
