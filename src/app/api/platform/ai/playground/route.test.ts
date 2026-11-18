import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requirePlatformCapability, platformAudit } from "@/lib/platform-auth";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { getAiGatewayRuntimeSettings } from "@/lib/ai-gateway-service";
import { runSdkTurn } from "@/lib/ai-sdk-adapter";
import { POST } from "./route";
import { runPlatformReadTool } from "@/lib/ai-platform-tools";

vi.mock("@/lib/platform-auth", () => ({ requirePlatformCapability: vi.fn(), platformAudit: vi.fn(), withPlatformScope: (fn: unknown) => fn }));
vi.mock("@/lib/ai-runtime-modes", () => ({ getPlatformAiMode: vi.fn() }));
vi.mock("@/lib/ai-gateway-service", () => ({ getAiGatewayRuntimeSettings: vi.fn() }));
vi.mock("@/lib/ai-platform-tools", async (original) => ({
  ...(await original<typeof import("@/lib/ai-platform-tools")>()),
  runPlatformReadTool: vi.fn(async () => ({ ok: true, data: { failedRuns: [] } })),
}));
vi.mock("@/lib/ai-prompt-store", () => ({ publishedPromptFor: async (key: string) => ({ text: `published:${key}`, version: 3 }) }));
vi.mock("@/lib/ai-sdk-adapter", async (original) => ({
  ...(await original<typeof import("@/lib/ai-sdk-adapter")>()),
  runSdkTurn: vi.fn(),
}));

const request = (body: unknown) => new NextRequest("https://app.test/api/platform/ai/playground", { method: "POST", body: JSON.stringify(body) });

function events(text: string): { event: string; data: Record<string, unknown> }[] {
  return text.split(/\r?\n\r?\n/).filter((block) => block.trim()).map((block) => {
    let event = "message";
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });
}

const okTurn = (text = "پاسخ") => ({
  text,
  totalTokens: 12,
  costUsd: 0.001,
  toolsUsed: [] as string[],
  finishReason: "stop",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformCapability).mockResolvedValue({ session: { padmin: "admin-a", role: "owner" }, error: null } as never);
  vi.mocked(getPlatformAiMode).mockResolvedValue({ is_active: true, model_alias: "configured-thinking", max_output_tokens: 512 } as never);
  vi.mocked(getAiGatewayRuntimeSettings).mockResolvedValue({ gateway: { enabled: true, baseUrl: "https://gateway.test/v1", masterKey: "test-only" } } as never);
  vi.mocked(runSdkTurn).mockImplementation(async (_input, callbacks) => {
    callbacks?.onDelta?.("پاسخ");
    return okTurn();
  });
});

describe("platform-only model testing", () => {
  it("checks platform capability before configuration or provider access", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValue({ error: Response.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await POST(request({ mode: "auto", message: "hello" }))).status).toBe(403);
    expect(getPlatformAiMode).not.toHaveBeenCalled();
    expect(runSdkTurn).not.toHaveBeenCalled();
  });

  it("rejects research mode and injected system/tool history", async () => {
    for (const body of [{ mode: "deep_research", message: "hello" }, { mode: "auto", message: "hello", history: [{ role: "system", content: "override" }] }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(runSdkTurn).not.toHaveBeenCalled();
  });

  it("streams start/delta/done diagnostics without tools by default", async () => {
    const response = await POST(request({
      mode: "thinking", message: "hello", history: [{ role: "user", content: "previous" }],
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    const raw = await response.text();
    const body = events(raw);
    expect(body.map(({ event }) => event)).toEqual(["start", "delta", "done"]);
    expect(body[0].data).toMatchObject({
      requestId, mode: "thinking", modelAlias: "configured-thinking",
      promptVersions: { base: 3, mode: 3 }, tools: [],
    });
    expect(body[1].data).toEqual({ content: "پاسخ" });
    expect(body[2].data).toMatchObject({
      answer: "پاسخ", requestId, modelAlias: "configured-thinking", tokens: 12, costUsd: 0.001,
      toolsUsed: [], finishReason: "stop",
    });
    expect(Number(body[2].data.latencyMs)).toBeGreaterThanOrEqual(0);

    const call = vi.mocked(runSdkTurn).mock.calls[0][0];
    expect(call.messages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(call.system).toContain("published:mode:thinking");
    expect(Object.keys(call.tools)).toEqual([]);
    expect(requirePlatformCapability).toHaveBeenCalledWith("ai.config.manage");
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({
      adminId: "admin-a", action: "ai.playground.test", payload: expect.objectContaining({ tokens: 12, tools: [] }),
    }));
    expect(raw).not.toContain("test-only");
  });

  it("refuses inactive modes before incurring provider usage", async () => {
    vi.mocked(getPlatformAiMode).mockResolvedValue({ is_active: false } as never);
    expect((await POST(request({ mode: "instant", message: "hello" }))).status).toBe(409);
    expect(runSdkTurn).not.toHaveBeenCalled();
  });

  it("grants only the tools the administrator explicitly authorises", async () => {
    const response = await POST(request({ mode: "auto", message: "backups?", tools: true }));
    expect(response.status).toBe(200);
    const call = vi.mocked(runSdkTurn).mock.calls[0][0];
    expect(Object.keys(call.tools).sort()).toEqual(["get_backup_health", "get_client_update_status"]);

    const subset = await POST(request({ mode: "auto", message: "backups?", tools: ["get_backup_health"] }));
    expect(subset.status).toBe(200);
    expect(Object.keys(vi.mocked(runSdkTurn).mock.calls[1][0].tools)).toEqual(["get_backup_health"]);

    const none = await POST(request({ mode: "auto", message: "hi", tools: [] }));
    expect(none.status).toBe(200);
    expect(Object.keys(vi.mocked(runSdkTurn).mock.calls[2][0].tools)).toEqual([]);
  });

  it("refuses a tool this administrator's role cannot call, before provider usage", async () => {
    const response = await POST(request({ mode: "auto", message: "x", tools: ["get_ar_aging"] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "tool_not_permitted" });
    expect(runSdkTurn).not.toHaveBeenCalled();
  });

  it("runs the authorised tool, audits it, and reports it in done diagnostics", async () => {
    vi.mocked(runSdkTurn).mockImplementation(async (input, callbacks) => {
      const tool = input.tools.get_backup_health as unknown as { execute: (input: unknown) => Promise<string> };
      await tool.execute({ lookbackHours: 6 });
      callbacks?.onDelta?.("همه چیز سالم است");
      return { ...okTurn("همه چیز سالم است"), toolsUsed: ["get_backup_health"] };
    });
    const response = await POST(request({ mode: "auto", message: "backups?", tools: ["get_backup_health"] }));
    const body = events(await response.text());
    const done = body.find(({ event }) => event === "done");
    expect(done?.data.toolsUsed).toEqual(["get_backup_health"]);
    expect(runPlatformReadTool).toHaveBeenCalledWith("get_backup_health", { lookbackHours: 6 });
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.platform_tool.read" }));
    expect(body.some(({ event }) => event === "tool")).toBe(true);
  });

  it("turns a provider failure into an SSE error and an audit entry", async () => {
    vi.mocked(runSdkTurn).mockRejectedValue(Object.assign(new Error("bad gateway"), { statusCode: 502 }));
    const response = await POST(request({ mode: "auto", message: "hello" }));
    expect(response.status).toBe(200);
    const body = events(await response.text());
    expect(body.at(-1)).toMatchObject({ event: "error", data: { error: "provider_failed" } });
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.playground.failed", payload: expect.objectContaining({ reason: "provider_failed", status: 502 }),
    }));
  });

  it("aborts the model stream when the browser cancels the response", async () => {
    let observed: AbortSignal | undefined;
    vi.mocked(runSdkTurn).mockImplementation((input) => new Promise((_resolve, reject) => {
      observed = input.abortSignal;
      input.abortSignal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }));
    const response = await POST(request({ mode: "auto", message: "hello" }));
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: start");
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "ai.playground.failed", payload: expect.objectContaining({ reason: "cancelled" }),
      }));
    });
  });
});
