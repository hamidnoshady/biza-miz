/**
 * Provider-half tests for the standalone (non-chat) receipt OCR call behind
 * `POST /api/ai/receipt-ocr`, with `fetch` stubbed — no network, no database.
 *
 * What must never regress:
 *   • it sends ONE vision turn (system prompt + image data URL) to
 *     /chat/completions, exactly the shape the chat assistant's
 *     `draft_expense_from_receipt` tool already sends (same prompt pair, so
 *     the two callers can never silently drift into extracting different
 *     fields from the same photo);
 *   • provider failures map to the exact ReceiptOcrError codes the route
 *     translates into Persian HTTP errors (ai_auth → 502, ai_timeout/
 *     ai_network → 504, an unparseable reply → 422 extraction_failed);
 *   • the caller settles the wallet only after this function returns fields,
 *     never on a throw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "./ai";
import { ReceiptOcrError, runReceiptOcr } from "./ai-receipt-service";

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

describe("runReceiptOcr", () => {
  it("sends one vision turn (no tools) and returns the parsed fields with usage", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  vendor: "سوپرمارکت رضا",
                  expenseDate: "2026-01-05",
                  amount: 350000,
                  memo: "خرید ملزومات دفتر",
                  suggestedAccountCode: "5500",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 700, completion_tokens: 40 },
        },
        { headers: { "content-type": "application/json", "x-litellm-response-cost": "0.002" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runReceiptOcr({ config, dataUrl: PNG_DATA_URL });

    expect(result.fields.vendor).toBe("سوپرمارکت رضا");
    expect(result.fields.amount).toBe(350000);
    expect(result.fields.suggestedAccountCode).toBe("5500");
    expect(result.usage).toEqual({ inputTokens: 700, outputTokens: 40 });
    expect(result.costUsd).toBeCloseTo(0.002);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe("gpt-4o-mini");
    // Extraction is not creativity — temperature is clamped low, same as
    // every other single-purpose vision call in this codebase.
    expect(body.temperature).toBeLessThanOrEqual(0.2);
    expect(body).not.toHaveProperty("tools");
    const userParts = body.messages[1].content as { type: string; image_url?: { url: string } }[];
    expect(userParts.some((p) => p.type === "image_url" && p.image_url?.url === PNG_DATA_URL)).toBe(true);
  });

  it("maps 401/403 to ai_auth — the route's 502, never a silent retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(runReceiptOcr({ config, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({ code: "ai_auth" });
  });

  it("maps an abort to ai_timeout and a socket error to ai_network", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortErr)));
    await expect(runReceiptOcr({ config, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({ code: "ai_timeout" });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(runReceiptOcr({ config, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({ code: "ai_network" });
  });

  it("refuses an unparseable reply as extraction_failed rather than inventing fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: "متأسفم، نمی‌توانم" } }] })),
    );
    await expect(runReceiptOcr({ config, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({
      code: "extraction_failed",
    });
    await expect(runReceiptOcr({ config, dataUrl: PNG_DATA_URL })).rejects.toBeInstanceOf(ReceiptOcrError);
  });

  it("estimates tokens when the provider omits usage (billing still settles)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: JSON.stringify({ amount: 10000, memo: "قهوه" }) } }],
        }),
      ),
    );
    const result = await runReceiptOcr({ config, dataUrl: PNG_DATA_URL });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeNull();
  });

  it("maps a non-401/403 error status to ai_provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(runReceiptOcr({ config, dataUrl: PNG_DATA_URL })).rejects.toMatchObject({ code: "ai_provider" });
  });
});
