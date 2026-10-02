/**
 * The AEC error map, including the half of it that is not AEC's.
 *
 * `/api/aec/projects/**` runs the workspace module's per-project
 * authorization (`requireProjectCapability`) on top of its own permission
 * check, so a refusal can arrive as either an `AecError` (the business's
 * industry or its operating profile said no) or a `WorkspaceError` (the caller
 * is not on this project). Both must reach the client as the right status —
 * before this was asserted, the workspace half fell through the AEC map's
 * `throw` and answered an ordinary 403 with a 500.
 */
import { describe, expect, it } from "vitest";
import { AecError } from "@/lib/aec-service";
import { WorkspaceError } from "@/lib/workspace";
import { handleAecError } from "./guard";

async function statusOf(error: unknown): Promise<number> {
  return handleAecError(error).status;
}

describe("handleAecError", () => {
  it("maps the AEC codes the service throws", async () => {
    expect(await statusOf(new AecError("industry_mismatch"))).toBe(403);
    expect(await statusOf(new AecError("role_not_allowed"))).toBe(403);
    expect(await statusOf(new AecError("participant_exists"))).toBe(409);
    expect(await statusOf(new AecError("participant_not_found"))).toBe(404);
    expect(await statusOf(new AecError("invalid_area"))).toBe(400);
  });

  it("maps the workspace codes the project gate throws", async () => {
    expect(await statusOf(new WorkspaceError("project_not_found"))).toBe(404);
    expect(await statusOf(new WorkspaceError("not_a_project_member"))).toBe(403);
    expect(await statusOf(new WorkspaceError("insufficient_project_role"))).toBe(403);
  });

  it("still refuses to dress an unknown error up as a 4xx", () => {
    expect(() => handleAecError(new Error("boom"))).toThrow("boom");
  });
});
