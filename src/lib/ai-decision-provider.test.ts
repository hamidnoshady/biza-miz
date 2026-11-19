import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateSystemOne } from "./ai-decision-provider";

const config = { apiKey: "test-key", model: "jev-pinned-example" };
const request = {
  state: "\u067e\u06cc\u06af\u06cc\u0631\u06cc \u0633\u0641\u0627\u0631\u0634",
  questions: {
    topic: { type: "choice", instructions: "Select topic", criteria: { order: "Order", other: "Other" } },
    urgency: { type: "score", instructions: "Rate urgency", criteria: ["Normal", "Urgent"] },
    follow_up: { type: "noul", instructions: "Does this need a follow-up?" },
  },
} as const;

const reply = {
  model: config.model,
  answers: {
    topic: { type: "choice", choice: "order", confidence: 0.7, probabilities: { order: 0.8, other: 0.2 } },
    urgency: { type: "score", score: 0.25, confidence: 0.8, legend: { 0: "Normal", 1: "Urgent" }, probabilities: { 0: 0.75, 1: 0.25 } },
    follow_up: { type: "noul", noul: 0.96 },
  },
  usage: { input_tokens: 80, output_tokens: 12 },
};

afterEach(() => vi.unstubAllGlobals());

describe("System One decision provider", () => {
  it("batches typed questions and sends only the explicit wire fields", async () => {
    const send = vi.fn(async (_url: string, _options: RequestInit) => Response.json(reply));
    vi.stubGlobal("fetch", send);
    const scopedRequest = { ...request, businessId: "must-not-leave", questions: {
      ...request.questions,
      topic: { ...request.questions.topic, policyVersion: 1 },
    } };
    expect(await evaluateSystemOne(scopedRequest, config)).toEqual({
      status: "evaluated", model: config.model,
      answers: { ...reply.answers, follow_up: { type: "noul", probabilityYes: 0.96 } },
      usage: { inputTokens: 80, outputTokens: 12 },
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, options] = send.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(options.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(options.body))).toEqual({ model: config.model, ...request });
  });

  it.each([
    { ...reply, model: "different-model" },
    { ...reply, answers: { ...reply.answers, extra: {} } },
    { ...reply, answers: { ...reply.answers, topic: { ...reply.answers.topic, choice: "other" } } },
    { ...reply, answers: { ...reply.answers, topic: { ...reply.answers.topic, probabilities: { order: 0.8, admin: 0.2 } } } },
    { ...reply, answers: { ...reply.answers, urgency: { ...reply.answers.urgency, legend: { 0: "Normal", 1: "Other" } } } },
    { ...reply, answers: { ...reply.answers, follow_up: { type: "noul", noul: 1.01 } } },
    { ...reply, usage: { input_tokens: -1, output_tokens: 10 } },
  ])("fails closed on an invalid evaluation %#", async (invalid) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(invalid)));
    expect(await evaluateSystemOne(request, config)).toEqual({ status: "unavailable", reason: "invalid_response" });
  });

  it("fails closed on oversized or non-JSON responses", async () => {
    for (const body of ["<html>unexpected</html>", "a".repeat(65_537)]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      expect(await evaluateSystemOne(request, config)).toEqual({ status: "unavailable", reason: "invalid_response" });
    }
  });

  it("does not send invalid, oversized, unconfigured or pre-aborted requests", async () => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    // 4,100 Persian characters: inside the 8,192-character cap but 8,200 UTF-8
    // bytes, so it is the byte limit that rejects this state, not the length.
    expect(await evaluateSystemOne({ ...request, state: "\u0634".repeat(4_100) }, config)).toMatchObject({ reason: "invalid_request" });
    expect(await evaluateSystemOne({ ...request, questions: {} }, config)).toMatchObject({ reason: "invalid_request" });
    expect(await evaluateSystemOne(request, { ...config, apiKey: "" })).toMatchObject({ reason: "not_configured" });
    expect(await evaluateSystemOne(request, config, AbortSignal.abort())).toMatchObject({ reason: "aborted" });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a provider failure without retrying or exposing the response body", async () => {
    const send = vi.fn(async () => new Response("private details", { status: 429 }));
    vi.stubGlobal("fetch", send);
    expect(await evaluateSystemOne(request, config)).toEqual({ status: "unavailable", reason: "provider_error", httpStatus: 429 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("propagates an in-flight abort with a sanitized result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("private details")), { once: true });
      });
    }));
    const controller = new AbortController();
    const pending = evaluateSystemOne(request, config, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "aborted" });
  });
});
