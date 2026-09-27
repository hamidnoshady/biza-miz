/**
 * Shared "one metered, non-streaming, tool-less vision turn" primitive
 * behind every standalone (non-chat) AI document-extraction service in this
 * app — `runReceiptOcr` (`ai-receipt-service.ts`) and `runInvoiceOcr`
 * (`ai-invoice-ocr-service.ts`).
 *
 * Extracted this session to close a real, previously-disclosed gap: both
 * services independently hand-wrote the exact same provider request shape,
 * `AbortController`/timeout handling, and `ai_auth`/`ai_timeout`/
 * `ai_network`/`ai_provider` error-code mapping, with only the prompt pair,
 * timeout, and token ceiling actually differing between them. This module is
 * that one definition; each caller supplies its own prompt pair and its own
 * error class via `createError` (so `rejects.toBeInstanceOf(ReceiptOcrError)`
 * / `InvoiceOcrError` keeps working unchanged — this is a shared *call*, not
 * a shared *error type*, since each caller's route maps its own error class
 * to its own HTTP response).
 *
 * Deliberately NOT a "document intelligence" abstraction over extraction
 * *semantics* — parsing the model's reply into receipt fields vs. invoice
 * lines stays in `ai-receipt.ts`/`ai-invoice-ocr.ts`, which know nothing
 * about each other and should not be forced to. This module only removes
 * the duplicated network/error-mapping shell around that parsing, which is
 * the concrete duplication that existed, not a speculative one.
 */

import { chatCompletionsUrl, type AiConfig } from "./ai";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { parseResponseCostHeader } from "./ai-gateway";

type ProviderContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string | ProviderContentPart[];
}

function providerHeaders(config: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Phase 37 & 39 — a gateway deployment authenticates the call with the
    // calling business/branch's virtual key when one has been provisioned;
    // every other deployment sends the platform key.
    Authorization: `Bearer ${config.gateway?.authKey || config.apiKey}`,
  };
}

function textOf(content: ProviderMessage["content"]): string {
  return typeof content === "string" ? content : "";
}

function fallbackUsage(messages: ProviderMessage[], content: string): AiTokenUsage {
  return {
    inputTokens: estimateTokens(JSON.stringify(messages)),
    outputTokens: estimateTokens(content),
  };
}

export interface AiVisionExtractionResult {
  text: string;
  usage: AiTokenUsage;
  costUsd: number | null;
}

/** Builds this caller's own error class instance for a given failure code. */
export type AiVisionExtractionErrorFactory = (code: string, message: string, detail?: string) => Error;

export interface AiVisionExtractionInput {
  config: AiConfig;
  systemPrompt: string;
  userPrompt: string;
  dataUrl: string;
  /** Aborts the request and maps to `ai_timeout` past this many ms. */
  timeoutMs: number;
  /** Lower bound passed to the provider — `config.maxOutputTokens` still wins when higher. */
  minOutputTokens: number;
  createError: AiVisionExtractionErrorFactory;
}

/**
 * One isolated, non-streaming, tool-less vision call to `/chat/completions`.
 * Throws the caller's own error (via `createError`) on a provider/network/
 * timeout failure or a reply with no message at all; returns the raw model
 * text otherwise — parsing that text into a caller-specific shape (receipt
 * fields, invoice lines, ...) is the caller's job, not this module's.
 */
export async function runAiVisionExtraction(input: AiVisionExtractionInput): Promise<AiVisionExtractionResult> {
  const messages: ProviderMessage[] = [
    { role: "system", content: input.systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: input.userPrompt },
        { type: "image_url", image_url: { url: input.dataUrl } },
      ],
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(input.config.baseUrl), {
      method: "POST",
      headers: providerHeaders(input.config),
      body: JSON.stringify({
        model: input.config.model,
        messages,
        temperature: Math.min(input.config.temperature, 0.2),
        max_tokens: Math.max(input.config.maxOutputTokens ?? 1000, input.minOutputTokens),
        // Phase 37 — the gateway's failover chain, when one is configured.
        // Empty for every deployment that talks to a vendor directly.
        ...(input.config.gateway?.body ?? {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw input.createError("ai_timeout", "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.");
    }
    throw input.createError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw input.createError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    throw input.createError("ai_provider", `سرویس هوش مصنوعی خطا داد (${res.status}).`, body);
  }

  const json = (await res.json()) as {
    choices?: { message?: ProviderMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw input.createError("ai_provider", "پاسخ سرویس هوش مصنوعی نامفهوم بود.");

  const text = textOf(message.content);
  const promptTokens = Number(json.usage?.prompt_tokens);
  const completionTokens = Number(json.usage?.completion_tokens);
  const usage =
    Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
      ? { inputTokens: Math.max(0, Math.floor(promptTokens)), outputTokens: Math.max(0, Math.floor(completionTokens)) }
      : fallbackUsage(messages, text);

  return {
    text,
    usage,
    costUsd: parseResponseCostHeader(res.headers.get("x-litellm-response-cost")),
  };
}
