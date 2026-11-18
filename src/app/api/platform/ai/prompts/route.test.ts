import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requirePlatformCapability } from "@/lib/platform-auth";
import { previewSystemPrompt } from "@/lib/ai-prompt-resolver";
import { publishPromptVersion, savePromptDraft } from "@/lib/ai-prompt-store";
import { GET, POST } from "./route";

vi.mock("@/lib/platform-auth", () => ({ requirePlatformCapability: vi.fn(), platformAudit: vi.fn() }));
vi.mock("@/lib/ai-prompt-resolver", () => ({ agentPromptScope: vi.fn(), previewSystemPrompt: vi.fn() }));
vi.mock("@/lib/ai-prompt-store", () => ({
  isPromptScopeKey: (key: unknown) => key === "base",
  PROMPT_SCOPES: [{ key: "base", label: "پایه", hint: "" }],
  listPromptVersions: vi.fn(),
  publishPromptVersion: vi.fn(),
  retirePromptVersion: vi.fn(),
  rollbackPromptVersion: vi.fn(),
  savePromptDraft: vi.fn(),
}));
vi.mock("@/lib/ai-system-agents", () => ({ listSystemAgents: vi.fn() }));

const path = "https://app.test/api/platform/ai/prompts";
const request = (body: unknown) => new NextRequest(path, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformCapability).mockResolvedValue({ session: { padmin: "admin", email: "admin@example.test" }, error: null } as never);
});

describe("Superadmin prompt scope and publication guards", () => {
  it("checks read and manage capabilities before loading or modifying prompt text", async () => {
    vi.mocked(requirePlatformCapability).mockImplementation(async () => ({
      session: null, error: Response.json({ error: "forbidden" }, { status: 403 }),
    }) as never);
    expect((await GET(new NextRequest(`${path}?previewScope=base`))).status).toBe(403);
    expect((await POST(request({ action: "draft", scopeKey: "base", text: "draft" }))).status).toBe(403);
    expect(requirePlatformCapability).toHaveBeenNthCalledWith(1, "ai.read");
    expect(requirePlatformCapability).toHaveBeenNthCalledWith(2, "ai.config.manage");
    expect(previewSystemPrompt).not.toHaveBeenCalled();
    expect(savePromptDraft).not.toHaveBeenCalled();
  });

  it("rejects an invalid preview scope before invoking the composer", async () => {
    expect((await GET(new NextRequest(`${path}?previewScope=invalid`))).status).toBe(400);
    expect(previewSystemPrompt).not.toHaveBeenCalled();
  });

  it("uses the requested active profile for a memory-free preview", async () => {
    vi.mocked(previewSystemPrompt).mockResolvedValue({ systemPrompt: "preview", layers: {} } as never);
    const response = await GET(new NextRequest(`${path}?previewScope=base&mode=thinking`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(previewSystemPrompt).toHaveBeenCalledWith("base", "thinking");
  });

  it("sends the reviewed draft and live-version expectation to the transactional publisher", async () => {
    vi.mocked(publishPromptVersion).mockResolvedValue({ ok: false, error: "prompt_publish_conflict" });
    const id = "01234567-89ab-4def-8123-456789abcdef";
    const response = await POST(request({ action: "publish", id, expectedPublishedId: null }));
    expect(response.status).toBe(409);
    expect(publishPromptVersion).toHaveBeenCalledWith(expect.objectContaining({
      id, requiredState: "draft", expectedPublishedId: null, audit: expect.any(Function),
    }));
  });
});
