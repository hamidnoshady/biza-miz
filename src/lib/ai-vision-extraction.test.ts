/**
 * Direct coverage for the shared vision-call primitive extracted this
 * session out of `ai-receipt-service.ts` and `ai-invoice-ocr-service.ts`
 * (Section V: "no shared document-intelligence abstraction" — this is the
 * one piece of real, previously-duplicated shell that was worth sharing;
 * see the module's own header comment for what deliberately stayed apart).
 *
 * `runReceiptOcr`/`runInvoiceOcr`'s own test files already prove each
 * caller's error class and prompt wiring end-to-end; this file proves the
 * shared call itself — request shape, timeout/error mapping, and usage/cost
 * parsing — independent of either caller, with `fetch` stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "./ai";
import { runAiVisionExtraction } from "./ai-vision-extraction";

const config: AiConfig = {
  enabled: true,
  provider: "litellm",
  model: "gpt-4o-mini",
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-test",
  temperature: 0.7,
  maxOutputTokens: 800,
};

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

class TestError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "TestError";
  }
}

function baseInput(overrides: Partial<Parameters<typeof runAiVisionExtraction>[0]> = {}) {
  return {
    config,
    systemPrompt: "system prompt",
    userPrompt: "user prompt",
    dataUrl: PNG_DATA_URL,
    timeoutMs: 5_000,
    minOutputTokens: 1024,
    createError: (code: string, message: string, detail?: string) => new TestError(code, message, detail),
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runAiVisionExtraction", () => {
  it("posts one system+user(text+image) turn to /chat/completions, with max_tokens honoring the higher of config vs. minOutputTokens", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runAiVisionExtraction(baseInput({ minOutputTokens: 4096 }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: "user prompt" },
          { type: "image_url", image_url: { url: PNG_DATA_URL } },
        ],
      },
    ]);
    // config.maxOutputTokens (800) < minOutputTokens (4096) — the floor wins.
    expect(body.max_tokens).toBe(4096);
  });

  it("authenticates with the gateway virtual key when one is provisioned, the platform key otherwise", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await runAiVisionExtraction(baseInput());
    let [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");

    fetchMock.mockClear();
    await runAiVisionExtraction(
      baseInput({ config: { ...config, gateway: { authKey: "vk-branch-1" } } as AiConfig }),
    );
    [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer vk-branch-1");
  });

  it("maps an abort to the caller's ai_timeout and a socket error to ai_network", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortErr)));
    await expect(runAiVisionExtraction(baseInput())).rejects.toMatchObject({ code: "ai_timeout" });
    await expect(runAiVisionExtraction(baseInput())).rejects.toBeInstanceOf(TestError);

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(runAiVisionExtraction(baseInput())).rejects.toMatchObject({ code: "ai_network" });
  });

  it("maps 401/403 to the caller's ai_auth with the response body as detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid key", { status: 401 })));
    await expect(runAiVisionExtraction(baseInput())).rejects.toMatchObject({
      code: "ai_auth",
      detail: "invalid key",
    });
  });

  it("maps any other non-ok status to the caller's ai_provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(runAiVisionExtraction(baseInput())).rejects.toMatchObject({ code: "ai_provider", detail: "boom" });
  });

  it("maps a reply with no message at all to ai_provider rather than returning empty text silently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [] })));
    await expect(runAiVisionExtraction(baseInput())).rejects.toMatchObject({ code: "ai_provider" });
  });

  it("uses the provider's reported usage when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: "extracted text" } }],
          usage: { prompt_tokens: 123, completion_tokens: 45 },
        }),
      ),
    );
    const result = await runAiVisionExtraction(baseInput());
    expect(result.text).toBe("extracted text");
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it("estimates usage from the request/reply when the provider omits it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: { content: "some reply" } }] })));
    const result = await runAiVisionExtraction(baseInput());
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("reads the gateway's own cost header when present, and returns null when absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
          { headers: { "content-type": "application/json", "x-litellm-response-cost": "0.0042" } },
        ),
      ),
    );
    const withCost = await runAiVisionExtraction(baseInput());
    expect(withCost.costUsd).toBeCloseTo(0.0042);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] })),
    );
    const withoutCost = await runAiVisionExtraction(baseInput());
    expect(withoutCost.costUsd).toBeNull();
  });
});
