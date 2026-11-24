/**
 * Issue #1140 §A5 — the one place the Vercel AI SDK touches this codebase.
 *
 * The SDK is the application's orchestration layer (typed tool calls, the step
 * loop, usage accounting); LiteLLM stays the gateway. That is why the model is
 * built here from the gateway settings with `createOpenAICompatible` and a
 * *model object* is always passed to the SDK: a bare model-id string would make
 * the SDK resolve it through the Vercel AI Gateway, which this product does not
 * use. `assertSdkModelIsGatewayBound` pins that in a unit test.
 *
 * Slice 1 (this file's only caller) is the Superadmin assistant route. The
 * tenant chat keeps its own tool loop and SSE protocol until parity tests exist
 * for it; nothing here changes how tenants are billed or settled.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createUIMessageStream, createUIMessageStreamResponse, generateText, isStepCount, jsonSchema, streamText, tool, type UIMessage, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { OpenAiTool } from "./ai";
import { toolProgressEvent, type AiToolProgressEvent } from "./ai-tool-progress";

export interface GatewayModelSettings {
  baseUrl: string;
  apiKey: string;
  /** LiteLLM alias, never a provider model id. */
  model: string;
  fetch?: typeof fetch;
}

/** A LiteLLM-bound chat model. The base URL is the gateway's, including its `/v1`. */
export function gatewayChatModel(settings: GatewayModelSettings): LanguageModel {
  const provider = createOpenAICompatible({
    name: "litellm",
    baseURL: settings.baseUrl.replace(/\/+$/, ""),
    apiKey: settings.apiKey,
    includeUsage: true,
    ...(settings.fetch ? { fetch: settings.fetch } : {}),
  });
  return provider.chatModel(settings.model);
}

/** True for a model object the SDK will call directly rather than route by id string. */
export function assertSdkModelIsGatewayBound(model: LanguageModel): void {
  if (typeof model === "string") throw new Error("ai_sdk_model_must_be_gateway_bound");
}

/**
 * Turns the app's existing OpenAI-style tool declarations into SDK tools whose
 * `execute` is the app's own executor. The declarations stay the single source
 * of truth, so a tool added to `ai.ts` is not described twice.
 *
 * Issue #1546 — `hooks.onToolProgress` is the shared way an SDK caller surfaces
 * "a tool is running / finished / failed" to its stream. It is the same
 * vocabulary and the same label helper the tenant loop uses, so an SDK-based
 * surface cannot invent a second progress protocol (and cannot leak arguments:
 * the event carries a server-built label only).
 */
export function sdkToolsFrom(
  declared: readonly OpenAiTool[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  hooks?: { onToolProgress?: (event: AiToolProgressEvent) => void; round?: number },
): ToolSet {
  const tools: ToolSet = {};
  for (const declaration of declared) {
    const { name, description, parameters } = declaration.function;
    tools[name] = tool({
      description,
      inputSchema: jsonSchema(parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown) => {
        const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
        hooks?.onToolProgress?.(toolProgressEvent(name, "running", hooks.round ?? 1));
        try {
          const output = await execute(name, args);
          hooks?.onToolProgress?.(toolProgressEvent(name, "completed", hooks.round ?? 1));
          return output;
        } catch (error) {
          hooks?.onToolProgress?.(toolProgressEvent(name, "failed", hooks.round ?? 1));
          throw error;
        }
      },
    });
  }
  return tools;
}

export interface SdkTurnInput {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  /** Hard ceiling on model calls in one turn (tool rounds + the final answer). */
  maxSteps: number;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface SdkTurnResult {
  text: string;
  totalTokens: number;
  /** Sum of LiteLLM's per-call `x-litellm-response-cost`, or null when absent. */
  costUsd: number | null;
  toolsUsed: string[];
}

/**
 * One bounded assistant turn. The step ceiling is a stop condition, so the last
 * allowed step can still be a plain answer instead of another tool request.
 */
export async function runSdkTurn(input: SdkTurnInput): Promise<SdkTurnResult> {
  const result = await generateText(sdkTurnOptions(input));
  return summarizeSdkTurn(input, result);
}

function sdkTurnOptions(input: SdkTurnInput) {
  assertSdkModelIsGatewayBound(input.model);
  return {
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: isStepCount(input.maxSteps),
    prepareStep: ({ stepNumber }: { stepNumber: number }) => stepNumber >= input.maxSteps - 1 ? { activeTools: [] } : undefined,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    abortSignal: input.abortSignal,
    maxRetries: 0,
  };
}

function summarizeSdkTurn(
  input: SdkTurnInput,
  result: Pick<Awaited<ReturnType<typeof generateText>>, "steps" | "text" | "totalUsage">,
): SdkTurnResult {
  let costUsd: number | null = null;
  for (const step of result.steps) {
    const raw = step.response?.headers?.["x-litellm-response-cost"];
    const cost = Number(raw);
    if (raw !== undefined && Number.isFinite(cost) && cost >= 0) costUsd = (costUsd ?? 0) + cost;
  }
  const used = Number(result.totalUsage?.totalTokens);
  return {
    text: result.text,
    totalTokens: Number.isFinite(used) ? Math.max(0, used) : 0,
    costUsd,
    // Only calls that name a tool this turn actually offered; a hallucinated name is not "used".
    toolsUsed: result.steps.flatMap((step) => step.toolCalls.map((call) => String(call.toolName)).filter((name) => name in input.tools)),
  };
}

type Diagnostics = Record<string, unknown>;
type PlaygroundUiMessage = UIMessage<unknown, { diagnostics: Diagnostics; completion: Diagnostics }>;

export function streamSdkTurn(input: SdkTurnInput, handlers: {
  started: Diagnostics;
  finished: (result: SdkTurnResult) => Promise<Diagnostics>;
  failed: (error: unknown) => Promise<string>;
}): Response {
  const stream = createUIMessageStream<PlaygroundUiMessage>({
    async execute({ writer }) {
      writer.write({ type: "start" });
      writer.write({ type: "data-diagnostics", data: handlers.started });
      writer.write({ type: "text-start", id: "answer" });
      try {
        let providerError: unknown;
        const result = streamText({
          ...sdkTurnOptions(input),
          onError: ({ error }) => { providerError = error; },
        });
        let text = "";
        for await (const delta of result.textStream) {
          const visible = delta.slice(0, Math.max(0, 16_000 - text.length));
          if (!visible) continue;
          text += visible;
          writer.write({ type: "text-delta", id: "answer", delta: visible });
        }
        if (input.abortSignal?.aborted) throw input.abortSignal.reason;
        if (providerError) throw providerError;
        if (!text.trim()) throw new Error("invalid_provider_reply");
        const summary = summarizeSdkTurn(input, {
          text, steps: await result.steps, totalUsage: await result.totalUsage,
        });
        const diagnostics = await handlers.finished(summary);
        writer.write({ type: "text-end", id: "answer" });
        writer.write({ type: "data-completion", data: diagnostics });
        writer.write({ type: "finish" });
      } catch (error) {
        writer.write({ type: "text-end", id: "answer" });
        writer.write({ type: "error", errorText: await handlers.failed(error) });
      }
    },
    onError: () => "provider_failed",
  });
  return createUIMessageStreamResponse({
    stream,
    headers: { "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
