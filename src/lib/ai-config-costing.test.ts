import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn() }));

import { query } from "./db";
import { defaultPlatformConfig, effectiveRate } from "./ai-config";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  mockQuery.mockReset();
  const envKeys = [
    "AI_PROVIDER",
    "AI_ENABLED",
    "AI_MODEL",
    "AI_BASE_URL",
    "AI_TEMPERATURE",
    "AI_MAX_OUTPUT_TOKENS",
    "AI_INPUT_COST_RIAL_PER_MILLION",
    "AI_OUTPUT_COST_RIAL_PER_MILLION",
    "AI_REVENUE_MARGIN_PERCENT",
    "AI_MAX_TURN_RIAL",
    "LITELLM_ENABLED",
    "LITELLM_BASE_URL",
    "LITELLM_MASTER_KEY",
    "LITELLM_CHAT_MODEL",
    "LITELLM_GATEWAY_COSTING_ENABLED",
    "LITELLM_USD_RIAL_RATE",
  ];
  for (const key of envKeys) delete process.env[key];
});

describe("LiteLLM bootstrap environment ownership", () => {
  it("uses explicit LITELLM_* connection values and ignores legacy direct-provider variables", () => {
    Object.assign(process.env, {
      LITELLM_ENABLED: "true",
      LITELLM_BASE_URL: "https://litellm.example/v1",
      LITELLM_MASTER_KEY: "sk-proxy-admin",
      LITELLM_CHAT_MODEL: "pos-chat",
      AI_ENABLED: "true",
      AI_PROVIDER: "openrouter",
      AI_BASE_URL: "https://vendor.example/v1",
      AI_API_KEY: "sk-direct-vendor",
      AI_MODEL: "direct-model",
    });

    const config = defaultPlatformConfig();
    expect(config).toMatchObject({
      enabled: true,
      provider: "litellm",
      baseUrl: "https://litellm.example/v1",
      apiKey: "sk-proxy-admin",
      model: "pos-chat",
    });
  });
});

describe("effectiveRate — cost plus margin, never below cost", () => {
  it("applies the revenue margin on top of the provider cost", () => {
    expect(effectiveRate(40_000, 25)).toBe(50_000);
    expect(effectiveRate(80_000, 25)).toBe(100_000);
  });

  it("zero margin sells at cost", () => {
    expect(effectiveRate(40_000, 0)).toBe(40_000);
  });

  it("rounds up so a fraction of a margin never sells below cost", () => {
    expect(effectiveRate(1, 0.5)).toBe(2);
  });

  it("a missing cost means no rate — the service stays unconfigured", () => {
    expect(effectiveRate(0, 50)).toBe(0);
  });
});
