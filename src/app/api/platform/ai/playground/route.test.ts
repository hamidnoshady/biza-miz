import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requirePlatformCapability, platformAudit } from "@/lib/platform-auth";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { getAiGatewayRuntimeSettings } from "@/lib/ai-gateway-service";
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
const request = (body: unknown) => new NextRequest("https://app.test/api/platform/ai/playground", { method: "POST", body: JSON.stringify(body) });
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
