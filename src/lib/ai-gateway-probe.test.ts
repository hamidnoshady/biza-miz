/**
 * The probe's gateway half, against a stubbed proxy.
 *
 * `probeGateway` is the console's view of what the gateway is actually doing,
 * so what matters is that it reports the proxy's own answers rather than an
 * echo of the stored settings: whether the proxy is alive (and how fast it
 * answered) and the aliases it is serving. Migration 0168 stopped the console
 * mirroring the proxy's router settings, budgets and rate limits — routing is
 * configured in docker/litellm/config.yaml and nowhere else — so the probe
 * must not ask about them at all, which the last test pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeGateway } from "./ai-gateway-service";
import { defaultGatewayConfig, type AiGatewayConfig } from "./ai-gateway";

const CONFIG: AiGatewayConfig = {
  ...defaultGatewayConfig(),
  enabled: true,
  baseUrl: "http://litellm:4000/v1",
  masterKey: "sk-master",
  chatModel: "pos-chat",
  embeddingModel: "pos-embed",
};

type Stub = { status: number; body: unknown };

function stubProxy(routes: Record<string, Stub>) {
  const urls: string[] = [];
  const auth: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const headerValue = init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>).Authorization
        : undefined;
      if (headerValue) auth.push(headerValue);
      const match = Object.entries(routes).find(([path]) => url.endsWith(path));
      const answer = match?.[1] ?? { status: 404, body: { error: "not found" } };
      return {
        status: answer.status,
        text: async () => (answer.body === null ? "" : JSON.stringify(answer.body)),
      } as Response;
    }),
  );
  return { urls, auth };
}

const MODEL_INFO = {
  data: [
    { model_name: "pos-chat" },
    { model_name: "pos-cheap" },
    { model_name: "pos-embed" },
  ],
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the probe", () => {
  it("reports liveliness, latency and the aliases the proxy is serving", async () => {
    const { urls } = stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
      "/model/info": { status: 200, body: MODEL_INFO },
      "/v1/chat/completions": { status: 200, body: { choices: [{ message: { role: "assistant", content: "pong" } }] } },
    });

    const probe = await probeGateway(CONFIG);

    expect(probe.ok).toBe(true);
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(probe.models).toEqual(["pos-chat", "pos-cheap", "pos-embed"]);
    expect(probe.error).toBeNull();
    // The data plane URL the console stores is answered at its management
    // root, not under /v1.
    expect(urls).toContain("http://litellm:4000/health/liveliness");
    expect(urls).toContain("http://litellm:4000/model/info");
  });

  it("fails precisely when the master key is missing", async () => {
    const { urls } = stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
    });

    const probe = await probeGateway({ ...CONFIG, masterKey: "" });

    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("کلید مدیر");
    expect(probe.models).toEqual([]);
    expect(urls.some((url) => url.includes("/model/info"))).toBe(false);
  });

  it("treats a missing model listing as a model-alias diagnostic failure", async () => {
    // Health only proves the server exists; /model/info must expose the alias
    // before the application can safely send chat turns.
    stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
    });

    const probe = await probeGateway(CONFIG);

    expect(probe.ok).toBe(false);
    expect(probe.models).toEqual([]);
    expect(probe.error).toBeTruthy();
  });

  it("tests a business virtual key with the same selected model", async () => {
    const { auth } = stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
      "/model/info": { status: 200, body: MODEL_INFO },
      "/v1/chat/completions": { status: 200, body: { choices: [{ message: { role: "assistant", content: "pong" } }] } },
    });

    const probe = await probeGateway(CONFIG, { virtualKey: "sk-tenant" });

    expect(probe.ok).toBe(true);
    expect(probe.stages.find((stage) => stage.key === "virtual_key_completion")?.ok).toBe(true);
    expect(auth).toContain("Bearer sk-master");
    expect(auth).toContain("Bearer sk-tenant");
  });

  it("reports a failure with the proxy's own words, without inventing a model list", async () => {
    stubProxy({});

    const probe = await probeGateway(CONFIG);

    expect(probe.ok).toBe(false);
    expect(probe.latencyMs).toBeNull();
    expect(probe.models).toEqual([]);
    expect(probe.error).toBeTruthy();
  });
});
