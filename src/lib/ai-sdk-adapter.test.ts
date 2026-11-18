import { describe, expect, it, vi } from "vitest";
import { assertSdkModelIsGatewayBound, gatewayChatModel, runSdkTurn, sdkToolsFrom } from "./ai-sdk-adapter";
import type { OpenAiTool } from "./ai";

const declared: OpenAiTool[] = [{
  type: "function",
  function: { name: "get_backup_health", description: "backup health", parameters: { type: "object", properties: { lookbackHours: { type: "number" } } } },
}];

function chunk(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function completion(choice: Record<string, unknown>, usage?: Record<string, number>): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "pos-chat",
    choices: [{ index: 0, ...choice }],
    ...(usage ? { usage } : {}),
  };
}

/** A LiteLLM-shaped SSE response, including LiteLLM's per-call cost header. */
function streamResponse(chunks: Record<string, unknown>[], cost = "0.002"): Response {
  const body = chunks.map(chunk).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "x-litellm-response-cost": cost },
  });
}

const answer = (text: string, usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) =>
  streamResponse([completion({ delta: { content: text }, finish_reason: "stop" }, usage)]);

const toolCall = (args = "{}") => streamResponse([
  completion({
    delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_backup_health", arguments: args } }] },
    finish_reason: null,
  }),
  completion({ delta: {}, finish_reason: "tool_calls" }, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
]);

function modelWith(replies: Response[]) {
  const fetchMock = vi.fn(async () => replies.shift() as Response);
  return { fetchMock, model: gatewayChatModel({ baseUrl: "https://gateway.test/v1/", apiKey: "sk-test", model: "pos-chat", fetch: fetchMock as unknown as typeof fetch }) };
}

describe("AI SDK adapter keeps LiteLLM as the gateway", () => {
  it("calls the gateway's chat-completions URL with the alias and bearer key, never a Vercel gateway", async () => {
    const { fetchMock, model } = modelWith([answer("سلام")]);
    const result = await runSdkTurn({ model, system: "s", messages: [{ role: "user", content: "hi" }], tools: {}, maxSteps: 2 });
    expect(result.text).toBe("سلام");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gateway.test/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(String(init.body)).model).toBe("pos-chat");
    expect(JSON.parse(String(init.body)).tools).toBeUndefined();
    expect(JSON.parse(String(init.body)).stream).toBe(true);
  });

  it("refuses a bare model-id string, which the SDK would route through the Vercel AI Gateway", () => {
    expect(() => assertSdkModelIsGatewayBound("openai/gpt-5" as never)).toThrow("ai_sdk_model_must_be_gateway_bound");
    expect(() => assertSdkModelIsGatewayBound(modelWith([]).model)).not.toThrow();
  });

  it("streams deltas through the callback and sums tokens and LiteLLM cost", async () => {
    const { model } = modelWith([answer("سلام")]);
    const seen: string[] = [];
    const result = await runSdkTurn(
      { model, system: "s", messages: [{ role: "user", content: "hi" }], tools: {}, maxSteps: 2 },
      { onDelta: (text) => seen.push(text) },
    );
    expect(seen.join("")).toBe("سلام");
    expect(result).toEqual({ text: "سلام", totalTokens: 8, costUsd: 0.002, toolsUsed: [], finishReason: "stop" });
  });

  it("runs the app's own executor for declared tools and reports each call in order", async () => {
    const { fetchMock, model } = modelWith([toolCall('{"lookbackHours":6}'), answer("همه سالم", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })]);
    const execute = vi.fn(async () => '{"failedRuns":[]}');
    const deltas: string[] = [];
    const calls: string[] = [];
    const result = await runSdkTurn({
      model, system: "s", messages: [{ role: "user", content: "backups?" }], tools: sdkToolsFrom(declared, execute), maxSteps: 3,
    }, {
      onDelta: (text) => deltas.push(text),
      onToolCall: (call) => calls.push(call.name),
    });
    expect(execute).toHaveBeenCalledWith("get_backup_health", { lookbackHours: 6 });
    expect(calls).toEqual(["get_backup_health"]);
    expect(deltas.join("")).toBe("همه سالم");
    expect(result).toEqual({ text: "همه سالم", totalTokens: 11, costUsd: 0.004, toolsUsed: ["get_backup_health"], finishReason: "stop" });
    const second = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: '{"failedRuns":[]}' });
  });

  it("offers no tools on the last allowed step", async () => {
    const { fetchMock, model } = modelWith([toolCall(), answer("پایان")]);
    const result = await runSdkTurn({ model, system: "s", messages: [{ role: "user", content: "x" }], tools: sdkToolsFrom(declared, async () => "{}"), maxSteps: 2 });
    expect(result.text).toBe("پایان");
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).tools).toBeUndefined();
  });

  it("does not count a tool name the turn never offered", async () => {
    const { model } = modelWith([toolCall(), answer("ok")]);
    const result = await runSdkTurn({ model, system: "s", messages: [{ role: "user", content: "x" }], tools: {}, maxSteps: 3 });
    expect(result.toolsUsed).toEqual([]);
  });

  it("aborts the provider stream when the caller's signal is aborted", async () => {
    const controller = new AbortController();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        if (!sent) {
          sent = true;
          streamController.enqueue(new TextEncoder().encode(chunk(completion({ delta: { content: "نیمه" }, finish_reason: null }))));
        }
        // Deliberately never closes: the abort is what must end the turn.
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const model = gatewayChatModel({ baseUrl: "https://gateway.test/v1", apiKey: "sk-test", model: "pos-chat", fetch: fetchMock as unknown as typeof fetch });
    await expect(runSdkTurn({
      model, system: "s", messages: [{ role: "user", content: "x" }], tools: {}, maxSteps: 2, abortSignal: controller.signal,
    }, {
      onDelta: () => controller.abort(),
    })).rejects.toMatchObject({ name: "AbortError" });
  }, 5000);
});
