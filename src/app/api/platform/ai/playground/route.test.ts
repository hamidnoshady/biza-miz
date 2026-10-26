import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requirePlatformCapability, platformAudit } from "@/lib/platform-auth";
import { getPlatformAiMode } from "@/lib/ai-runtime-modes";
import { getAiGatewayRuntimeSettings } from "@/lib/ai-gateway-service";
import { POST } from "./route";
vi.mock("@/lib/platform-auth", () => ({ requirePlatformCapability: vi.fn(), platformAudit: vi.fn(), withPlatformScope: (fn: unknown) => fn }));
vi.mock("@/lib/ai-runtime-modes", () => ({ getPlatformAiMode: vi.fn() }));
vi.mock("@/lib/ai-gateway-service", () => ({ getAiGatewayRuntimeSettings: vi.fn() }));
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
});
