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
import { generateText, isStepCount, jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
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
  assertSdkModelIsGatewayBound(input.model);
  const result = await generateText({
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
