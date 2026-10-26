import { describe, expect, it } from "vitest";
import { workspaceServiceGateDecision, workspaceServiceKeyForPath } from "./guard";

describe("paid Workspace API activation gate", () => {
  it("maps separately priced capabilities without gating the shared Workspace shell", () => {
    expect(workspaceServiceKeyForPath("/api/workspace/documents")).toBe("documents");
    expect(workspaceServiceKeyForPath("/api/workspace/documents/123")).toBe("documents");
    expect(workspaceServiceKeyForPath("/api/workspace/projects/123/tasks")).toBe("projects");
    expect(workspaceServiceKeyForPath("/api/workspace/dashboard")).toBe("projects");
  });

  it("allows reads and exports after a customer disable", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(
        workspaceServiceGateDecision({
          method,
          pathname: "/api/workspace/documents",
          state: "disabled_retained",
        }),
      ).toBeNull();
    }
  });

  it("blocks only mutations for a deliberately disabled capability", () => {
    expect(
      workspaceServiceGateDecision({
        method: "PATCH",
        pathname: "/api/workspace/documents/123",
        state: "disabled_retained",
      }),
    ).toEqual({ serviceKey: "documents", state: "disabled_retained" });
  });

  it("does not mistake setup, credit/platform suspension, or legal hold for customer disable", () => {
    for (const state of [
      null,
      "setup_in_progress",
      "suspended_insufficient_credit",
      "platform_unavailable",
      "legal_hold",
    ]) {
      expect(
        workspaceServiceGateDecision({
          method: "POST",
          pathname: "/api/workspace/projects",
          state,
        }),
      ).toBeNull();
    }
  });
});
