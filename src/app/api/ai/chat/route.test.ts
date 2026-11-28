import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { AiError, runAgentTurn } from "@/lib/ai-service";
import { resolveAiConfigFor } from "@/lib/ai-runtime";

// Issue #1546 Phase 3 — the `platform_ai_modes` rows this turn reads. Hoisted
// so the db mock below can route the modes SELECT here while every other query
// keeps the canned answer the rest of the suite relies on. Empty means "table
// has never been written", which the real read resolves to the seeded defaults.
const { modeRows } = vi.hoisted(() => ({
  modeRows: [] as Array<Record<string, unknown>>,
}));

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
  query: vi.fn(async (sql: unknown) => {
    // Phase 3: the mode read is real, so it must see the rows a test sets.
    // Everything else keeps the canned business-name answer from before.
    if (typeof sql === "string" && sql.includes("platform_ai_modes")) {
      return { rows: modeRows };
    }
    return { rows: [{ name: "کافه تست" }] };
  }),
  withTenantScope: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => fn()),
  withoutTenantScope: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/industry-guard", () => ({
  getBusinessIndustry: vi.fn(async () => "food_service"),
}));

vi.mock("@/lib/features", () => ({
  effectiveFeatures: vi.fn(async () => ({ ai_assistant: true })),
}));

vi.mock("@/lib/app-availability-service", () => ({
  effectiveAppAvailability: vi.fn(async () => ({
    accounting: { usable: true },
    crm: { usable: true },
    growth: { usable: true },
    website: { usable: true },
  })),
}));

vi.mock("@/lib/ai-runtime", async (importOriginal) => {
  // Phase 3 keeps `applyRuntimeModeAlias` REAL so a turn's outgoing `model` is
  // the actual alias application, not a pass-through mock; only the DB-reaching
  // resolve is replaced. The pure alias behaviour itself is pinned in
  // `ai-runtime-mode-aliases.test.ts`.
  const actual = await importOriginal<typeof import("@/lib/ai-runtime")>();
  return {
    ...actual,
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
  };
});

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

  it("passes the page hint and trusted app state to the selector, never as a grant", async () => {
    const { runAgentTurn } = await import("@/lib/ai-service");
    const req = new NextRequest("http://localhost:3000/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "چقدر دیروز فروختیم؟" }],
        routePath: "/accounting/pos",
      }),
    });

    const res = await POST(req);
    await readStreamText(res);
    expect(vi.mocked(runAgentTurn)).toHaveBeenCalledWith(
      expect.objectContaining({
        appFocus: null,
        toolSelection: expect.objectContaining({
          routeApp: "accounting",
          enabledApps: ["accounting", "crm", "growth", "website"],
          branchScope: null,
        }),
      }),
    );
  });

  it("clamps a client focus to a usable app instead of widening it", async () => {
    const { effectiveAppAvailability } = await import("@/lib/app-availability-service");
    vi.mocked(effectiveAppAvailability).mockResolvedValueOnce({
      accounting: { usable: true } as never,
      crm: { usable: true } as never,
      growth: { usable: true } as never,
      website: { usable: false } as never,
    });
    const { runAgentTurn } = await import("@/lib/ai-service");
    const req = new NextRequest("http://localhost:3000/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "وضعیت سایت" }],
        appFocus: "website",
      }),
    });

    const res = await POST(req);
    await readStreamText(res);
    expect(vi.mocked(runAgentTurn)).toHaveBeenCalledWith(
      expect.objectContaining({ appFocus: null }),
    );
  });
});

/**
 * Issue #1546 Phase 3 — the mode a member picks decides which LiteLLM alias the
 * turn asks for, and Fast must never silently ride the default/reasoning route.
 *
 * The rows below are what `platform_ai_modes` holds (seeded blank by migrations
 * 0203/0256); `getPlatformAiMode`, `modeAvailability` and
 * `applyRuntimeModeAlias` are all the real implementations. Only the gateway
 * resolve (`resolveAiConfigFor`) and the provider loop (`runAgentTurn`) are
 * replaced, so the assertion lands on the exact `model` that would go into the
 * `/v1/chat/completions` body.
 */
describe("POST /api/ai/chat — runtime-mode routing (issue #1546 Phase 3)", () => {
  const modeRow = (mode: string, overrides: Record<string, unknown> = {}) => ({
    mode_key: mode,
    model_alias: "",
    is_active: true,
    temperature: null,
    max_output_tokens: null,
    prompt_scope_key: `mode:${mode}`,
    ...overrides,
  });

  const setModeRows = (...rows: Array<Record<string, unknown>>) => {
    modeRows.length = 0;
    modeRows.push(...rows);
  };

  const postTurn = (runtimeMode?: string) =>
    POST(
      new NextRequest("http://localhost:3000/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "سلام" }],
          ...(runtimeMode ? { runtimeMode } : {}),
        }),
      }),
    );

  beforeEach(() => {
    setModeRows(modeRow("auto"), modeRow("instant"), modeRow("thinking"));
    vi.mocked(runAgentTurn).mockClear();
    vi.mocked(resolveAiConfigFor).mockClear();
  });

  it("refuses Fast when its alias is blank instead of routing it to the default model", async () => {
    const res = await postTurn("instant");

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        error: "mode_unavailable",
        mode: "instant",
        reason: "fast_alias_not_configured",
      }),
    );
    // The refusal happens before any gateway resolve or provider loop, so an
    // unavailable Fast cannot have quietly used the Auto/Thinking deployment.
    expect(resolveAiConfigFor).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("sends Fast's own configured alias as the model once it exists", async () => {
    setModeRows(
      modeRow("auto"),
      modeRow("instant", { model_alias: "pos-instant" }),
      modeRow("thinking"),
    );

    const res = await postTurn("instant");
    expect(res.status).toBe(200);
    await readStreamText(res);

    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ model: "pos-instant" }),
      }),
    );
  });

  it("keeps Auto on the gateway default when its alias is blank", async () => {
    const res = await postTurn();
    expect(res.status).toBe(200);
    await readStreamText(res);

    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ model: "pos-chat" }),
      }),
    );
  });

  it("routes Thinking to its own alias when configured, else to the gateway default", async () => {
    // Blank Thinking alias — supported state: the gateway default, same as Auto.
    let res = await postTurn("thinking");
    expect(res.status).toBe(200);
    await readStreamText(res);
    expect(runAgentTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ model: "pos-chat" }),
      }),
    );

    // Configured Thinking alias replaces the default for that turn.
    setModeRows(
      modeRow("auto"),
      modeRow("instant"),
      modeRow("thinking", { model_alias: "pos-thinking" }),
    );
    res = await postTurn("thinking");
    expect(res.status).toBe(200);
    await readStreamText(res);
    expect(runAgentTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ model: "pos-thinking" }),
      }),
    );
  });

  it("does not offer a console-disabled mode as a routable turn", async () => {
    setModeRows(
      modeRow("auto"),
      modeRow("instant", { model_alias: "pos-instant" }),
      modeRow("thinking", { is_active: false }),
    );

    const res = await postTurn("thinking");
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        error: "mode_unavailable",
        mode: "thinking",
        reason: "disabled",
      }),
    );
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
