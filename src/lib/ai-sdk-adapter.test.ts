import { describe, expect, it, vi } from "vitest";
import { assertSdkModelIsGatewayBound, gatewayChatModel, runSdkTurn, sdkToolsFrom } from "./ai-sdk-adapter";
import type { OpenAiTool } from "./ai";

const declared: OpenAiTool[] = [{
  type: "function",
  function: { name: "get_backup_health", description: "backup health", parameters: { type: "object", properties: { lookbackHours: { type: "number" } } } },
}];
const toolCall = (args = "{}") => Response.json({
  choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_backup_health", arguments: args } }] }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
}, { headers: { "x-litellm-response-cost": "0.002" } });
const answer = (text: string) => Response.json({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
}, { headers: { "x-litellm-response-cost": "0.001" } });

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
  });

  it("refuses a bare model-id string, which the SDK would route through the Vercel AI Gateway", () => {
    expect(() => assertSdkModelIsGatewayBound("openai/gpt-5" as never)).toThrow("ai_sdk_model_must_be_gateway_bound");
    expect(() => assertSdkModelIsGatewayBound(modelWith([]).model)).not.toThrow();
  });

  it("runs the app's own executor for declared tools and sums tokens and LiteLLM cost", async () => {
    const { fetchMock, model } = modelWith([toolCall('{"lookbackHours":6}'), answer("همه سالم")]);
    const execute = vi.fn(async () => '{"failedRuns":[]}');
    const result = await runSdkTurn({
      model, system: "s", messages: [{ role: "user", content: "backups?" }], tools: sdkToolsFrom(declared, execute), maxSteps: 3,
    });
    expect(execute).toHaveBeenCalledWith("get_backup_health", { lookbackHours: 6 });
    expect(result).toEqual({ text: "همه سالم", totalTokens: 14, costUsd: 0.003, toolsUsed: ["get_backup_health"] });
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
});
