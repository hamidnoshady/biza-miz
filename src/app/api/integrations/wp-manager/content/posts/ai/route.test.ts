import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/ai-runtime", () => ({ resolveAiConfigFor: vi.fn() }));
vi.mock("@/lib/ai-config", () => ({
  isPlatformAiConfigured: vi.fn(),
  logAiRuntimeUnavailable: vi.fn(() => "not_configured"),
}));
vi.mock("@/lib/ai-wallet-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-wallet-billing")>();
  return {
    ...actual,
    gateAiTurn: vi.fn(),
    settleAiTurn: vi.fn(),
    newAiRequestId: vi.fn(() => "req-editorial"),
  };
});
vi.mock("@/lib/editorial-ai-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/editorial-ai-service")>();
  return { ...actual, runEditorialDraft: vi.fn() };
});
// The route must never reach a write path; if any of these were called the
// test fails loudly instead of silently queueing content.
vi.mock("@/lib/integrations/wp-content-service", () => ({
  enqueueWpPostUpsert: vi.fn(),
  findWpContentCreateRequest: vi.fn(),
  getWpContent: vi.fn(),
  upsertWpContent: vi.fn(),
}));
vi.mock("@/lib/integrations/audit", () => ({ writeIntegrationAudit: vi.fn() }));

import * as auth from "@/lib/auth";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as setupState from "@/lib/setup-state";
import * as aiRuntime from "@/lib/ai-runtime";
import * as aiConfig from "@/lib/ai-config";
import * as wallet from "@/lib/ai-wallet-billing";
import * as editorialService from "@/lib/editorial-ai-service";
import * as wpContent from "@/lib/integrations/wp-content-service";
import { POST } from "./route";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const CONNECTION_ID = "conn-woo-1";
const CONFIG = { model: "test-model", apiKey: "k" };

function post(body: unknown) {
  return new Request("http://localhost/api/integrations/wp-manager/content/posts/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

const VALID_BODY = {
  connectionId: CONNECTION_ID,
  type: "post",
  action: "shorten",
  title: "راهنمای نگهداری فرش",
  content: "<p>متن طولانی…</p>",
  excerpt: "خلاصه",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue({
    id: CONNECTION_ID,
    provider: "woocommerce",
    status: "active",
  } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(aiRuntime.resolveAiConfigFor).mockResolvedValue(CONFIG as never);
  vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(true);
  vi.mocked(wallet.gateAiTurn).mockResolvedValue(undefined as never);
  vi.mocked(wallet.settleAiTurn).mockResolvedValue({ chargedRial: 1200 } as never);
  vi.mocked(editorialService.runEditorialDraft).mockResolvedValue({
    text: "متن کوتاه‌شده",
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    costUsd: 0.001,
  } as never);
});

describe("POST /api/integrations/wp-manager/content/posts/ai", () => {
  it("needs the ability that owns store content, not a read-only one", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await POST(post(VALID_BODY));

    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceManage);
    expect(response.status).toBe(403);
    expect(editorialService.runEditorialDraft).not.toHaveBeenCalled();
  });

  it("returns a draft and settles the turn, and writes nothing anywhere", async () => {
    const response = await POST(post(VALID_BODY));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, draft: { text: "متن کوتاه‌شده" }, action: "shorten", costRial: 1200 });
    expect(editorialService.runEditorialDraft).toHaveBeenCalledWith({
      config: CONFIG,
      request: expect.objectContaining({ action: "shorten", title: "راهنمای نگهداری فرش" }),
    });
    expect(wallet.settleAiTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-editorial",
        attribution: expect.objectContaining({ requestType: "editorial_draft", metadata: expect.objectContaining({ connectionId: CONNECTION_ID }) }),
      }),
    );
    // The whole point: no queue event, no mirror write, no audit of a write.
    expect(wpContent.enqueueWpPostUpsert).not.toHaveBeenCalled();
    expect(wpContent.upsertWpContent).not.toHaveBeenCalled();
  });

  it("refuses to spend credit on a paused connection", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      status: "paused",
    } as never);

    const response = await POST(post(VALID_BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "connection_paused" });
    expect(wallet.gateAiTurn).not.toHaveBeenCalled();
    expect(editorialService.runEditorialDraft).not.toHaveBeenCalled();
  });

  it("hides connections of another business behind not_found", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(null as never);

    const response = await POST(post(VALID_BODY));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("asks for title or text instead of letting the model invent a page", async () => {
    const response = await POST(post({ ...VALID_BODY, action: "rewrite", title: "", content: "", excerpt: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty_content" });
    expect(editorialService.runEditorialDraft).not.toHaveBeenCalled();
  });

  it("needs a title before outlining a blank page", async () => {
    const response = await POST(post({ connectionId: CONNECTION_ID, type: "page", action: "outline" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "title_required" });
  });

  it("rejects actions, tones and languages it does not know", async () => {
    expect((await POST(post({ ...VALID_BODY, action: "summarise_all" }))).status).toBe(400);
    expect((await POST(post({ ...VALID_BODY, action: "tone", tone: "shouty" }))).status).toBe(400);
    expect((await POST(post({ ...VALID_BODY, action: "translate", language: "klingon" }))).status).toBe(400);
    expect(editorialService.runEditorialDraft).not.toHaveBeenCalled();
  });

  it("reports an unavailable AI service as 503 and keeps the wallet untouched", async () => {
    vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(false);

    const response = await POST(post(VALID_BODY));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("ai_unavailable");
    expect(wallet.gateAiTurn).not.toHaveBeenCalled();
  });

  it("reports an empty wallet as 402 with a message the writer can act on", async () => {
    vi.mocked(wallet.gateAiTurn).mockRejectedValue(new wallet.AiWalletInsufficientError(0, 0, 5000));

    const response = await POST(post(VALID_BODY));
    const json = await response.json();

    expect(response.status).toBe(402);
    expect(json.error).toBe("ai_credit_required");
    expect(json.message).toContain("اعتبار");
    expect(editorialService.runEditorialDraft).not.toHaveBeenCalled();
  });

  it("reports a failed turn as 502 and settles nothing", async () => {
    vi.mocked(editorialService.runEditorialDraft).mockRejectedValue(
      new editorialService.EditorialError("ai_unreadable", "bad reply"),
    );

    const response = await POST(post(VALID_BODY));

    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("ai_failed");
    expect(wallet.settleAiTurn).not.toHaveBeenCalled();
  });

  it("trims and bounds the material handed to the model", async () => {
    await POST(post({ ...VALID_BODY, title: `  ${"ع".repeat(400)}  `, instruction: `  ${"د".repeat(500)}  ` }));

    const call = vi.mocked(editorialService.runEditorialDraft).mock.calls[0][0];
    expect(call.request.title).toHaveLength(200);
    expect(call.request.instruction).toHaveLength(300);
    expect(call.request.title?.startsWith(" ")).toBe(false);
  });
});
