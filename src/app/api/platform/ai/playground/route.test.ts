import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requirePlatformCapability, platformAudit } from "@/lib/platform-auth";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { getAiGatewayRuntimeSettings } from "@/lib/ai-gateway-service";
import { POST } from "./route";
import { getPromptVersion } from "@/lib/ai-prompt-store";
import { runPlatformReadTool } from "@/lib/ai-platform-tools";
import { checkRateLimit } from "@/lib/rate-limit";
vi.mock("@/lib/rate-limit", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: vi.fn(),
}));
vi.mock("@/lib/platform-auth", () => ({ requirePlatformCapability: vi.fn(), platformAudit: vi.fn(), withPlatformScope: (fn: unknown) => fn }));
vi.mock("@/lib/ai-runtime-modes", () => ({ getPlatformAiMode: vi.fn() }));
vi.mock("@/lib/ai-gateway-service", () => ({ getAiGatewayRuntimeSettings: vi.fn() }));
vi.mock("@/lib/ai-platform-tools", async (original) => ({
  ...(await original<typeof import("@/lib/ai-platform-tools")>()),
  runPlatformReadTool: vi.fn(async () => ({ ok: true, data: { failedRuns: [] } })),
}));
vi.mock("@/lib/ai-prompt-store", () => ({ getPromptVersion: vi.fn(), isPromptScopeKey: () => true, publishedPromptFor: async (key: string) => ({ text: `published:${key}`, version: 3 }) }));
const request = (body: unknown) => new NextRequest("https://app.test/api/platform/ai/playground", { method: "POST", body: JSON.stringify(body) });
const streamRequest = (body: unknown, signal?: AbortSignal) => new NextRequest("https://app.test/api/platform/ai/playground", {
  method: "POST", body: JSON.stringify(body), headers: { Accept: "text/event-stream" }, signal,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformCapability).mockResolvedValue({ session: { padmin: "admin-a" }, error: null } as never);
  vi.mocked(getPlatformAiMode).mockResolvedValue({ is_active: true, model_alias: "configured-thinking", max_output_tokens: 512 } as never);
  vi.mocked(getAiGatewayRuntimeSettings).mockResolvedValue({ gateway: { enabled: true, baseUrl: "https://gateway.test/v1", masterKey: "test-only" } } as never);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "پاسخ" } }], usage: { total_tokens: 12 } })));
});
describe("platform-only model testing", () => {
  it("checks platform capability before configuration or provider access", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValue({ error: Response.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await POST(request({ mode: "auto", message: "hello" }))).status).toBe(403);
    expect(getPlatformAiMode).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects research mode and injected system/tool history", async () => {
    for (const body of [{ mode: "deep_research", message: "hello" }, { mode: "auto", message: "hello", history: [{ role: "system", content: "override" }] }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the configured alias and published prompts without tools or tenant credentials", async () => {
    const response = await POST(request({ mode: "thinking", message: "hello", history: [{ role: "user", content: "previous" }] }));
    expect(response.status).toBe(200);
    expect(requirePlatformCapability).toHaveBeenCalledWith("ai.config.manage");
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.model).toBe("configured-thinking");
    expect(body.messages[0].content).toContain("published:mode:thinking");
    expect(body.tools).toBeUndefined();
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({ adminId: "admin-a", action: "ai.playground.test" }));
    expect(JSON.stringify(await response.json())).not.toContain("test-only");
  });
  it("refuses inactive modes before incurring provider usage", async () => {
    vi.mocked(getPlatformAiMode).mockResolvedValue({ is_active: false } as never);
    expect((await POST(request({ mode: "instant", message: "hello" }))).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("runs a bounded platform-tool loop only when asked, per the admin's own role", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValue({ session: { padmin: "admin-a", role: "owner" }, error: null } as never);
    const replies = [
      Response.json({ choices: [{ message: { content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "get_backup_health", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "get_ar_aging", arguments: "{}" } },
      ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }),
      Response.json({ choices: [{ message: { content: "همه چیز سالم است" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => replies.shift() as Response));
    const response = await POST(request({ mode: "auto", message: "backups?", tools: true }));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.answer).toBe("همه چیز سالم است");
    expect(json.toolsUsed).toEqual(["get_backup_health"]);
    // The tenant tool the model invented never ran; the platform one ran once.
    expect(runPlatformReadTool).toHaveBeenCalledTimes(1);
    const first = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(first.tools.map((t: { function: { name: string } }) => t.function.name).sort())
      .toEqual(["get_backup_health", "get_client_update_status"]);
    const second = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(second.messages.some((m: { role: string }) => m.role === "tool")).toBe(true);
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.platform_tool.read" }));
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.playground.test", payload: expect.objectContaining({ tokens: 15, tools: ["get_backup_health"] }),
    }));
  });

  it("offers only the named tools already allowed for the administrator", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValue({ session: { padmin: "admin-a", role: "owner" }, error: null } as never);
    const response = await POST(request({ mode: "auto", message: "backups?", tools: ["get_backup_health"] }));
    expect(response.status).toBe(200);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(["get_backup_health"]);
  });

  it("rejects ungranted tools before calling the gateway and records the denial", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValue({ session: { padmin: "admin-a", role: "owner" }, error: null } as never);
    const response = await POST(request({ mode: "auto", message: "test", tools: ["get_backup_health", "get_ar_aging"] }));
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.platform_tool.denied",
      payload: expect.objectContaining({ reason: "not_authorized_for_role", requestedCount: 2 }),
    }));
  });

  it("rejects malformed tool grants and prevents named tools during draft tests", async () => {
    const draftId = "01234567-89ab-4def-8123-456789abcdef";
    expect((await POST(request({ mode: "auto", message: "test", tools: [true] }))).status).toBe(400);
    expect((await POST(request({ mode: "auto", message: "test", tools: ["get_backup_health"], draftId }))).status).toBe(400);
    expect(getPromptVersion).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops asking for tools after the round limit and answers without them", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValue({ session: { padmin: "admin-a", role: "owner" }, error: null } as never);
    const loop = () => Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: "c", type: "function", function: { name: "get_backup_health", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    const replies = [loop(), loop(), loop(), Response.json({ choices: [{ message: { content: "نهایی" }, finish_reason: "stop" }] })];
    vi.stubGlobal("fetch", vi.fn(async () => replies.shift() as Response));
    const response = await POST(request({ mode: "auto", message: "again", tools: true }));
    expect((await response.json()).answer).toBe("نهایی");
    const last = JSON.parse(String(vi.mocked(fetch).mock.calls[3][1]?.body));
    expect(last.tools).toBeUndefined();
  });
});

describe("Playground SDK streaming", () => {
  it.each([["auto", null], ["instant", "safe-fixture-fast"], ["thinking", "safe-fixture-thinking"]])(
    "resolves %s on the server and inherits absent gateway overrides",
    async (mode, alias) => {
      vi.mocked(getPlatformAiMode).mockResolvedValue({
        is_active: true, model_alias: alias, temperature: null, max_output_tokens: null,
      } as never);
      vi.mocked(getAiGatewayRuntimeSettings).mockResolvedValue({
        gateway: { enabled: true, baseUrl: "https://gateway.test/v1", masterKey: "test-only", chatModel: "safe-fixture-default" },
      } as never);
      const response = await POST(request({ mode, message: "test", modelAlias: "client-override" }));
      const providerBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
      expect(response.status).toBe(200);
      expect(getPlatformAiMode).toHaveBeenCalledWith(mode);
      expect(providerBody.model).toBe(alias ?? "safe-fixture-default");
      expect(providerBody.temperature).toBeUndefined();
    },
  );

  it("propagates cancellation to the LiteLLM request and audits cancellation", async () => {
    const controller = new AbortController();
    let providerStart!: () => void;
    const started = new Promise<void>((resolve) => { providerStart = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      providerStart();
    })));
    const response = await POST(streamRequest({ mode: "auto", message: "hello" }, controller.signal));
    const output = response.text();
    await started;
    controller.abort();
    expect(await output).toContain("request_cancelled");
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.playground.failed", payload: expect.objectContaining({ reason: "request_cancelled" }),
    }));
  });

  it("delivers an answer delta before the provider closes and audits completed usage", async () => {
    const encoder = new TextEncoder();
    let provider!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { provider = controller; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } })));
    const response = await POST(streamRequest({ mode: "thinking", message: "hello" }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    provider.enqueue(encoder.encode('data: {"id":"turn","model":"configured-thinking","choices":[{"index":0,"delta":{"content":"سلام"},"finish_reason":null}]}\n\n'));
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = "";
    while (!received.includes("text-delta")) {
      const next = await reader.read();
      if (next.done) throw new Error("Stream ended before the first delta");
      received += next.value;
    }
    expect(received).toContain("سلام");
    expect(received).not.toContain("data-completion");
    provider.enqueue(encoder.encode('data: {"id":"turn","model":"configured-thinking","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n'));
    provider.close();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value;
    }
    expect(received).toContain('"tokens":7');
    expect(received).toContain('"type":"finish"');
    expect(received).not.toContain("test-only");
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.playground.test", payload: expect.objectContaining({ tokens: 7 }),
    }));
  });

  it("sanitizes provider rate-limit errors and does not emit a successful finish", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "secret fixture" } }, { status: 429 })));
    const output = await (await POST(streamRequest({ mode: "auto", message: "hello" }))).text();
    expect(output).toContain("provider_rate_limited");
    expect(output).not.toContain("secret fixture");
    expect(output).not.toContain('"type":"finish"');
    expect(platformAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.playground.failed" }));
  });

  it("allows a saved matching draft only in an isolated model-only test", async () => {
    const draftId = "01234567-89ab-4def-8123-456789abcdef";
    vi.mocked(getPromptVersion).mockResolvedValue({
      id: draftId, scopeKey: "mode:thinking", state: "draft", text: "draft-only instructions", version: 7,
    } as never);
    expect((await POST(request({ mode: "auto", message: "test", draftId }))).status).toBe(409);
    expect((await POST(request({ mode: "thinking", message: "test", draftId, tools: true }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    const response = await POST(request({ mode: "thinking", message: "test", draftId }));
    expect(await response.json()).toMatchObject({ draftScope: "mode:thinking", promptVersions: { mode: 7 } });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.messages[0].content).toContain("draft-only instructions");
    expect(body.messages[0].content).not.toContain("published:mode:thinking");
    expect(body.tools).toBeUndefined();
  });
});

describe("Jev decision smoke", () => {
  const smoke = { decisionSmoke: "support-triage-v1" };

  beforeEach(() => {
    vi.stubEnv("TYPESAFE_DECISION_SMOKE_ENABLED", "1");
    vi.stubEnv("TYPESAFE_DECISION_SMOKE_KEY", "fixture-secret");
    vi.stubEnv("TYPESAFE_DECISION_SMOKE_MODEL", "fixture-model");
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps unauthorized, disabled and arbitrary request data out of the provider", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValueOnce({ error: Response.json({}, { status: 403 }) } as never);
    expect((await POST(request(smoke))).status).toBe(403);
    expect((await POST(request({ ...smoke, state: "private business record" }))).status).toBe(400);
    vi.stubEnv("TYPESAFE_DECISION_SMOKE_ENABLED", "0");
    expect((await POST(request(smoke))).status).toBe(409);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces a shared request limit before using the provider", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterMs: 1_250 });
    const response = await POST(request(smoke));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs only the registered case and audits usage without exposing the credential", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      model: "fixture-model",
      answers: {
        intent: { type: "choice", choice: "information", confidence: 0.9, probabilities: { information: 0.9, complaint: 0.05, other: 0.05 } },
        urgency: { type: "score", score: 0.1, confidence: 0.9, legend: {
          0: "Routine informational question", 1: "Time-sensitive issue", 2: "Immediate escalation required",
        }, probabilities: { 0: 0.9, 1: 0.1, 2: 0 } },
        follow_up: { type: "noul", noul: 0.1 },
      },
      usage: { input_tokens: 100, output_tokens: 20 },
    }));
    const response = await POST(request(smoke));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ passed: true, evaluation: { usage: { inputTokens: 100, outputTokens: 20 } } });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(getPlatformAiMode).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(platformAudit).toHaveBeenCalledTimes(2);
    expect(platformAudit).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "ai.playground.test", payload: expect.objectContaining({ provider: "jev", passed: true }),
    }));
  });

  it("audits a sanitized provider failure and returns no raw provider body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("provider private details", { status: 429 }));
    const response = await POST(request(smoke));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "provider_error" });
    expect(platformAudit).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "ai.playground.failed", payload: expect.objectContaining({ providerStatus: 429 }),
    }));
    expect(JSON.stringify(vi.mocked(platformAudit).mock.calls)).not.toContain("provider private details");
  });
});
