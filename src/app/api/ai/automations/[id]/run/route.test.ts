import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn(), runForMember: vi.fn() }));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/ai-automations-service", () => ({
  runAutomationForMember: mocks.runForMember,
}));

const key = "4C88D2F5-7AA4-4A10-8FC3-6D254989EEF7";

function post(idempotencyKey?: string) {
  return POST(new NextRequest("http://localhost/api/ai/automations/automation-1/run", {
    method: "POST",
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  }), { params: Promise.resolve({ id: "automation-1" }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requirePermission.mockResolvedValue({
    session: { businessId: "biz-1", sub: "member-1", role: "manager" },
  });
});

describe("manual automation run endpoint", () => {
  it("requires current tenant permission before a replay", async () => {
    mocks.requirePermission.mockResolvedValue({ error: NextResponse.json({}, { status: 403 }) });
    expect((await post(key)).status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.aiAutomationsManage);
    expect(mocks.runForMember).not.toHaveBeenCalled();
  });

  it("rejects an invalid replay key before execution", async () => {
    expect((await post("unsafe-key")).status).toBe(400);
    expect(mocks.runForMember).not.toHaveBeenCalled();
  });

  it("binds a normalized key to the current actor and returns an unfinished run as HTTP 202", async () => {
    const run = { runId: "run-1", outcome: "running" };
    mocks.runForMember.mockResolvedValue({ ok: true, run });
    const response = await post(key);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ run });
    expect(mocks.runForMember).toHaveBeenCalledWith({
      automationId: "automation-1", businessId: "biz-1", actorUserId: "member-1",
      isOwner: false, requestKey: key.toLowerCase(),
    });
  });

  it("returns the persisted failure to a caller instead of claiming success", async () => {
    const run = { runId: "run-1", outcome: "failed" };
    mocks.runForMember.mockResolvedValue({ ok: true, run });
    const response = await post(key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ run });
  });

  it("preserves owner-only enforcement and headerless callers", async () => {
    mocks.runForMember.mockResolvedValue({ ok: false, error: "owner_required" });
    const response = await post();
    expect(response.status).toBe(403);
    expect(mocks.runForMember).toHaveBeenCalledWith(expect.objectContaining({ requestKey: null }));
  });
});
