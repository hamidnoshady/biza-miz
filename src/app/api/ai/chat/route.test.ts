import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { AiError } from "@/lib/ai-service";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: (req: NextRequest) => Promise<Response>) => {
    return (req: NextRequest) => fn(req);
  },
  requireManager: vi.fn(async () => ({
    session: { businessId: "biz-1", sub: "user-1", fullName: "مدیر", role: "owner" },
    error: null,
  })),
  requireFloorAssistant: vi.fn(async () => ({
    session: { businessId: "biz-1", sub: "user-1", fullName: "صندوق‌دار", role: "cashier" },
    error: null,
  })),
  getBusinessFeatures: vi.fn(async () => ({ ai_assistant: true })),
  requireRole: vi.fn(),
}));

vi.mock("@/lib/setup-state", () => ({
  requireManager: vi.fn(async () => ({
    session: { businessId: "biz-1", sub: "user-1", fullName: "مدیر", role: "owner" },
    error: null,
  })),
  resolveActiveLocation: vi.fn(async () => ({ id: "loc-1", name: "شعبه مرکزی" })),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(async () => ({ rows: [{ name: "کافه تست" }] })),
  withTenantScope: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScope: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/ai-runtime", () => ({
  resolveAiConfigFor: vi.fn(async () => ({
    enabled: true,
    provider: "litellm",
    model: "pos-chat",
    baseUrl: "http://litellm:4000/v1",
    apiKey: "sk-tenant-12345",
    maxOutputTokens: 1000,
    temperature: 0.3,
    ready: true,
  })),
  // Issue #812 §3/§7 — the mode's alias. Passed through unchanged here so the
  // tests below keep asserting the chat behaviour rather than alias resolution;
  // `ai-runtime-mode-aliases.test.ts` pins what the real one does.
  applyRuntimeModeAlias: vi.fn((config: { model: string }) => config),
}));

vi.mock("@/lib/ai-config", () => ({
  isPlatformAiConfigured: vi.fn(() => true),
  logAiRuntimeUnavailable: vi.fn(() => "ready"),
  getAiRuntimeReadiness: vi.fn(() => ({
    ready: true,
    reason: null,
    gatewayReady: true,
    authenticationReady: true,
    virtualKeyRequired: false,
    virtualKeyReady: true,
    modelReady: true,
  })),
}));

vi.mock("@/lib/ai-wallet-billing", () => ({
  newAiRequestId: vi.fn(() => "req-123"),
  logAiTurnResult: vi.fn(),
  gateAiTurn: vi.fn(async () => ({
    allowed: true,
    allowanceRemainingRial: 1_000_000,
    walletBalanceRial: 500_000,
    concurrencyRelease: vi.fn(async () => {}),
  })),
  settleAiTurn: vi.fn(async () => ({
    chargedRial: 100,
    source: "allowance",
  })),
}));

vi.mock("@/lib/ai-conversations", () => ({
  getOrCreateConversation: vi.fn(async () => ({ id: "conv-1" })),
  appendMessage: vi.fn(async () => "msg-1"),
  getConversationProjectId: vi.fn(async () => null),
}));

vi.mock("@/lib/ai-service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/ai-service")>();
  return {
    ...mod,
    runAgentTurn: vi.fn(async () => {
      return {
        content: "پاسخ دستیار هوش مصنوعی",
        proposedAction: null,
        inputRequest: null,
        usage: { inputTokens: 10, outputTokens: 5 },
        costUsd: 0.0001,
        toolCalls: [],
      };
    }),
  };
});

async function readStreamText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("POST /api/ai/chat streaming error handling", () => {
  it("streams safe sanitized error when LiteLLM returns 400 AiError", async () => {
    const { runAgentTurn } = await import("@/lib/ai-service");
    vi.mocked(runAgentTurn).mockRejectedValueOnce(
      new AiError(
        "ai_invalid_request",
        "درخواست توسط سرویس هوش مصنوعی رد شد. مدیر پلتفرم می‌تواند جزئیات فنی را بررسی کند.",
        JSON.stringify({ error: { message: "Invalid model name pos-chat on upstream" } }),
        {
          status: 400,
          message: "Invalid model name pos-chat on upstream",
          type: "invalid_request_error",
          code: null,
          param: null,
          detail: "Invalid model name pos-chat on upstream",
          validation: [],
          sanitizedBody: "Invalid model name pos-chat on upstream",
        },
      ),
    );

    const req = new NextRequest("http://localhost:3000/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "سلام" }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await readStreamText(res);
    expect(text).toContain("event: error");
    expect(text).toContain("ai_invalid_request");
    expect(text).toContain("درخواست توسط سرویس هوش مصنوعی رد شد");
  });

  it("streams safe Persian message when generic error occurs", async () => {
    const { runAgentTurn } = await import("@/lib/ai-service");
    vi.mocked(runAgentTurn).mockRejectedValueOnce(new Error("unexpected crash"));

    const req = new NextRequest("http://localhost:3000/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "سلام" }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const text = await readStreamText(res);
    expect(text).toContain("event: error");
    expect(text).toContain("ai_unknown");
    expect(text).toContain("خطای غیرمنتظره");
  });

  it("streams successful chat turn", async () => {
    const req = new NextRequest("http://localhost:3000/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "سلام" }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const text = await readStreamText(res);
    expect(text).toContain("event: done");
    expect(text).toContain("پاسخ دستیار هوش مصنوعی");
  });
});
