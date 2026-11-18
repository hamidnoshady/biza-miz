/**
 * Issue #1140 §A5 — the one place the Vercel AI SDK touches this codebase.
 * ESH-184 — the Superadmin playground streams the turn instead of buffering it.
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
import { jsonSchema, isStepCount, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { OpenAiTool } from "./ai";

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
 */
export function sdkToolsFrom(
  declared: readonly OpenAiTool[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
): ToolSet {
  const tools: ToolSet = {};
  for (const declaration of declared) {
    const { name, description, parameters } = declaration.function;
    tools[name] = tool({
      description,
      inputSchema: jsonSchema(parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown) => {
        const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
        return execute(name, args);
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

/** Incremental output the caller may relay while the turn is still running. */
export interface SdkTurnCallbacks {
  /** One provider text delta, in order. */
  onDelta?: (text: string) => void;
  /** One tool call, before its executor runs. */
  onToolCall?: (call: { id: string; name: string; input: unknown }) => void;
  /** One tool result (or tool failure) after the executor ran. */
  onToolResult?: (result: { id: string; name: string; output: unknown; failed: boolean }) => void;
}

export interface SdkTurnResult {
  text: string;
  totalTokens: number;
  /** Sum of LiteLLM's per-call `x-litellm-response-cost`, or null when absent. */
  costUsd: number | null;
  toolsUsed: string[];
  finishReason: string | null;
}

function abortError(): Error {
  const error = new Error("The assistant turn was cancelled.");
  error.name = "AbortError";
  return error;
}

function totalTokensOf(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): number {
  const reported = Number(usage?.totalTokens);
  if (Number.isFinite(reported) && reported > 0) return reported;
  const input = Number(usage?.inputTokens);
  const output = Number(usage?.outputTokens);
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

/**
 * One bounded assistant turn, streamed. The step ceiling is a stop condition,
 * so the last allowed step can still be a plain answer instead of another tool
 * request. Cancellation reaches the provider through `abortSignal`, and the
 * caller observes deltas through `callbacks` while the turn runs.
 */
export async function runSdkTurn(
  input: SdkTurnInput,
  callbacks: SdkTurnCallbacks = {},
): Promise<SdkTurnResult> {
  assertSdkModelIsGatewayBound(input.model);
  const result = streamText({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    stopWhen: isStepCount(input.maxSteps),
    // The final allowed step offers no tools, so the turn must end in an answer.
    prepareStep: ({ stepNumber }) => (stepNumber >= input.maxSteps - 1 ? { activeTools: [] } : undefined),
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    abortSignal: input.abortSignal,
    maxRetries: 0,
  });

  let text = "";
  let totalTokens = 0;
  let costUsd: number | null = null;
  let finishReason: string | null = null;
  const toolsUsed: string[] = [];

  try {
    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta":
          if (part.text) {
            text += part.text;
            callbacks.onDelta?.(part.text);
          }
          break;
        case "tool-call":
          callbacks.onToolCall?.({ id: part.toolCallId, name: String(part.toolName), input: part.input });
          // Only a call the turn actually offered counts; a hallucinated name is not "used".
          if (String(part.toolName) in input.tools) toolsUsed.push(String(part.toolName));
          break;
        case "tool-result":
          callbacks.onToolResult?.({
            id: part.toolCallId,
            name: String(part.toolName),
            output: part.output,
            failed: false,
          });
          break;
        case "tool-error":
          callbacks.onToolResult?.({
            id: part.toolCallId,
            name: String(part.toolName),
            output: part.error,
            failed: true,
          });
          break;
        case "finish-step": {
          const usage = totalTokensOf(part.usage);
          if (usage > 0) totalTokens += usage;
          const raw = part.response?.headers?.["x-litellm-response-cost"];
          const cost = Number(raw);
          if (raw !== undefined && Number.isFinite(cost) && cost >= 0) costUsd = (costUsd ?? 0) + cost;
          break;
        }
        case "finish": {
          const usage = totalTokensOf(part.totalUsage);
          // `finish.totalUsage` is the aggregate; prefer it when a provider did
          // not report per-step usage (some gateways only report it once).
          if (totalTokens === 0 && usage > 0) totalTokens = usage;
          finishReason = part.finishReason ?? null;
          break;
        }
        case "abort":
          throw abortError();
        case "error":
          throw part.error instanceof Error ? part.error : new Error("ai_stream_error");
        default:
          break;
      }
    }
  } catch (error) {
    // Abort surfaces as a provider AbortError or an `abort` part. Both mean the
    // same thing to the caller, so normalise the name it checks.
    if (input.abortSignal?.aborted) throw abortError();
    throw error;
  }
  if (input.abortSignal?.aborted) throw abortError();

  return {
    text,
    totalTokens: Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0,
    costUsd,
    toolsUsed,
    finishReason,
  };
}

/** Explicit alias for callers that want the streaming intent in the call site. */
export const streamSdkTurn = runSdkTurn;
