import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as audit from "@/lib/ai-action-audit";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn(), withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler };
});
vi.mock("@/lib/ai-action-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-action-audit")>();
  return { ...actual, claimAiActionAudit: vi.fn(), finishAiActionAudit: vi.fn(), getAiActionAuditStatus: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1" };

function applyRequest(auditId: string) {
  return {
    json: async () => ({ auditId }),
    url: "https://app.test/api/ai/proposals/apply",
    headers: { get: () => null },
  } as unknown as NextRequest;
}

function claim(actionType: string, payload: Record<string, unknown>) {
  return {
    id: "audit-1",
    actorUserId: "user-1",
    source: "chat",
    actionType,
    actionTitle: "ثبت دریافت",
    actionSummary: "summary",
    payload,
    conversationId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    membership: {
      permissions: new Set([
        PERMISSIONS.aiUse,
        PERMISSIONS.aiManage,
        PERMISSIONS.financeReceivablesManage,
        PERMISSIONS.partiesManage,
      ]),
    },
    error: null,
  } as never);
  vi.mocked(audit.finishAiActionAudit).mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ receipt: { id: "receipt-1" } }) }),
  );
});

describe("POST /api/ai/proposals/apply idempotency", () => {
  it("injects a stable proposal-derived key for destinations that require one", async () => {
    vi.mocked(audit.claimAiActionAudit).mockResolvedValue(
      claim("ar.receipt.record", { customerId: "customer-1", method: "cash", amount: 100_000 }),
    );
    const response = await POST(applyRequest("audit-1"));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      customerId: "customer-1",
      idempotencyKey: "ai-proposal:audit-1",
    });
  });

  it("leaves other destinations' payloads untouched", async () => {
    vi.mocked(audit.claimAiActionAudit).mockResolvedValue(
      claim("party.customer.create", { displayName: "مشتری تازه" }),
    );
    const response = await POST(applyRequest("audit-9"));
    expect(response.status).toBe(200);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ displayName: "مشتری تازه" });
  });
});
