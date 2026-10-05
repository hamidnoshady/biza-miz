/**
 * Unit tests for the gateway layer's pure half.
 *
 * The gateway is an optional component sitting in front of an already-working
 * provider client, so the property that matters most is not what it does when
 * configured but that it does *nothing at all* when it isn't: no extra body
 * fields, no substituted key, no rewritten model. Those cases come first.
 */
import { describe, expect, it } from "vitest";
import {
  buildGatewayRuntime,
  defaultGatewayConfig,
  emptyBusinessGateway,
  gatewayErrorText,
  gatewayManagementUrl,
  gatewayTurnPricing,
  gatewayStatusMessage,
  joinGatewayDetail,
  keyInfoUrl,
  livelinessUrl,
  modelInfoUrl,
  parseGatewayErrorDetail,
  parseGatewayModels,
  parseGeneratedKey,
  parseKeySpend,
  parseResponseCostHeader,
  resolveChatModel,
  rialFromGatewayUsd,
  resolveEmbeddingModel,
  resolveGatewayAuthKey,
  toPublicGatewayConfig,
  validateGatewayInput,
  virtualKeyAlias,
  type AiGatewayConfig,
  type BusinessGateway,
} from "./ai-gateway";
import { defaultConfig, isProvider, PROVIDERS, type AiConfig } from "./ai";

function gateway(overrides: Partial<AiGatewayConfig> = {}): AiGatewayConfig {
  return { ...defaultGatewayConfig(), enabled: true, ...overrides };
}

function business(overrides: Partial<BusinessGateway> = {}): BusinessGateway {
  return { ...emptyBusinessGateway("b1"), ...overrides };
}

const platform: AiConfig = { ...defaultConfig("litellm"), apiKey: "sk-platform", model: "gpt-4o-mini" };

describe("provider catalogue", () => {
  it("accepts litellm as the sole provider", () => {
    expect(isProvider("litellm")).toBe(true);
    expect(PROVIDERS.litellm.defaultBaseUrl).toBe("http://litellm:4000/v1");
  });
});

describe("an inactive gateway changes nothing", () => {
  it("produces no runtime at all when the gateway is absent", () => {
    expect(buildGatewayRuntime({ config: platform, gateway: null, business: null })).toBeUndefined();
  });

  it("produces no runtime when the gateway row exists but is switched off", () => {
    expect(
      buildGatewayRuntime({ config: platform, gateway: defaultGatewayConfig(), business: null }),
    ).toBeUndefined();
  });

  it("sends no extra body fields when a runtime is built for an inactive gateway", () => {
    expect(buildGatewayRuntime({ config: platform, gateway: null, business: null })).toBeUndefined();
    expect(
      buildGatewayRuntime({ config: platform, gateway: { ...gateway(), enabled: false }, business: null }),
    ).toBeUndefined();
  });

  it("substitutes no key when no gateway credential exists", () => {
    expect(resolveGatewayAuthKey({ gateway: gateway({ virtualKeysEnabled: true }), business: null })).toBeUndefined();
  });
});

describe("model resolution", () => {
  it("keeps the platform model when the gateway sets no alias", () => {
    expect(resolveChatModel({ platformModel: "gpt-4o-mini", gateway: gateway(), business: null })).toBe(
      "gpt-4o-mini",
    );
  });

  it("prefers the gateway alias over the platform model", () => {
    expect(
      resolveChatModel({ platformModel: "gpt-4o-mini", gateway: gateway({ chatModel: "pos-chat" }), business: null }),
    ).toBe("pos-chat");
  });

  it("ignores business and branch identity when resolving the model — LiteLLM owns model policy", () => {
    const allowed = gateway({ chatModel: "pos-chat" });
    expect(
      resolveChatModel({
        platformModel: "gpt-4o-mini",
        gateway: allowed,
        business: business({ virtualKey: "sk-biz" }),
        branch: business({ virtualKey: "sk-branch" }),
      }),
    ).toBe("pos-chat");
  });

  it("falls back from the embedding alias to the chat alias to the platform model", () => {
    expect(
      resolveEmbeddingModel({
        platformModel: "gpt-4o-mini",
        gateway: gateway({ chatModel: "pos-chat", embeddingModel: "" }),
      }),
    ).toBe("pos-chat");
    expect(
      resolveEmbeddingModel({
        platformModel: "gpt-4o-mini",
        gateway: gateway({ chatModel: "", embeddingModel: "" }),
      }),
    ).toBe("gpt-4o-mini");
    expect(
      resolveEmbeddingModel({
        platformModel: "gpt-4o-mini",
        gateway: gateway({ chatModel: "pos-chat", embeddingModel: "pos-embed" }),
      }),
    ).toBe("pos-embed");
  });

  it("returns the plain platform model when there is no gateway", () => {
    expect(resolveEmbeddingModel({ platformModel: "gpt-4o-mini", gateway: null })).toBe("gpt-4o-mini");
  });
});

describe("credential resolution", () => {
  it("prefers the branch virtual key over business key when virtual keys are on", () => {
    const key = resolveGatewayAuthKey({
      gateway: gateway({ virtualKeysEnabled: true, masterKey: "sk-master" }),
      business: business({ virtualKey: "sk-biz" }),
      branch: business({ virtualKey: "sk-branch" }),
    });
    expect(key).toBe("sk-branch");
  });

  it("prefers the business virtual key when virtual keys are on and branch has none", () => {
    const key = resolveGatewayAuthKey({
      gateway: gateway({ virtualKeysEnabled: true, masterKey: "sk-master" }),
      business: business({ virtualKey: "sk-tenant" }),
    });
    expect(key).toBe("sk-tenant");
  });

  it("uses the master key for non-tenant/platform calls when no virtual key is present", () => {
    expect(
      resolveGatewayAuthKey({ gateway: gateway({ virtualKeysEnabled: true, masterKey: "sk-master" }), business: null }),
    ).toBe("sk-master");
  });

  it("never falls back to a shared master key for a tenant when virtual keys are required", () => {
    expect(
      resolveGatewayAuthKey({
        gateway: gateway({ virtualKeysEnabled: true, masterKey: "sk-master" }),
        business: null,
        tenantScoped: true,
      }),
    ).toBeUndefined();
  });

  it("uses the master key when virtual keys are off", () => {
    const key = resolveGatewayAuthKey({
      gateway: gateway({ virtualKeysEnabled: false, masterKey: "sk-master" }),
      business: business({ virtualKey: "sk-tenant" }),
    });
    expect(key).toBe("sk-master");
  });
});

describe("request body", () => {
  it("never sends request-level fallbacks or other routing policy", () => {
    const runtime = buildGatewayRuntime({
      config: platform,
      gateway: gateway({ chatModel: "pos-chat", masterKey: "sk-master" }),
      business: null,
    });
    expect(runtime).toEqual({
      model: "pos-chat",
      embeddingModel: "pos-chat",
      authKey: "sk-master",
      virtualKeyResolved: false,
      body: {},
    });
  });
});

describe("key identity", () => {
  // Migration 0168: a minted key is an IDENTITY, not a policy — it carries
  // only the alias (and the metadata the service adds). There is no models
  // allowlist to scope any more: changing the platform's chat alias must not
  // orphan every existing key against the new model, and model access is the
  // request path's decision (resolveChatModel), not the key's.
  it("derives a stable alias from the business id and branch id", () => {
    expect(virtualKeyAlias("3f2a-9c")).toBe("pos-3f2a9c");
    expect(virtualKeyAlias("3f2a-9c")).toBe(virtualKeyAlias("3f2a-9c"));
    expect(virtualKeyAlias("3f2a-9c", "loc-1234-5678")).toBe("pos-3f2a9c-loc12345");
  });
});

describe("management endpoints", () => {
  it("strips the /v1 suffix so management routes resolve", () => {
    expect(gatewayManagementUrl("http://litellm:4000/v1")).toBe("http://litellm:4000");
    expect(gatewayManagementUrl("http://litellm:4000/v1/")).toBe("http://litellm:4000");
    expect(gatewayManagementUrl("http://litellm:4000")).toBe("http://litellm:4000");
  });

  it("builds the endpoints the console calls", () => {
    expect(livelinessUrl("http://litellm:4000/v1")).toBe("http://litellm:4000/health/liveliness");
    expect(modelInfoUrl("http://litellm:4000/v1")).toBe("http://litellm:4000/model/info");
    expect(keyInfoUrl("http://litellm:4000/v1", "sk-a b")).toBe("http://litellm:4000/key/info?key=sk-a%20b");
  });
});

describe("response parsing", () => {
  it("reads model names from /model/info and de-duplicates them", () => {
    expect(
      parseGatewayModels({
        data: [{ model_name: "pos-chat" }, { model_name: "pos-cheap" }, { id: "pos-chat" }, {}],
      }),
    ).toEqual(["pos-chat", "pos-cheap"]);
  });

  it("returns no models rather than throwing on an unrecognised shape", () => {
    expect(parseGatewayModels(null)).toEqual([]);
    expect(parseGatewayModels({ data: "nope" })).toEqual([]);
    expect(parseGatewayModels({})).toEqual([]);
  });

  it("reads the generated key from either field LiteLLM has used", () => {
    expect(parseGeneratedKey({ key: "sk-new" })).toBe("sk-new");
    expect(parseGeneratedKey({ token: "sk-legacy" })).toBe("sk-legacy");
    expect(parseGeneratedKey({})).toBeNull();
    expect(parseGeneratedKey(null)).toBeNull();
  });

  it("reads spend from the nested info block, and from a flat body too", () => {
    expect(parseKeySpend({ key: "sk-1", info: { spend: 1.25, max_budget: 50 } })).toEqual({
      spendUsd: 1.25,
      maxBudgetUsd: 50,
    });
    expect(parseKeySpend({ spend: 0.5, max_budget: null })).toEqual({ spendUsd: 0.5, maxBudgetUsd: null });
    expect(parseKeySpend({ info: {} })).toBeNull();
    expect(parseKeySpend(null)).toBeNull();
  });

  it("maps statuses onto operator-readable messages", () => {
    expect(gatewayStatusMessage(401)).toContain("کلید مدیر");
    expect(gatewayStatusMessage(404)).toContain("یافت نشد");
    expect(gatewayStatusMessage(500)).toContain("خطای داخلی");
    expect(gatewayStatusMessage(418)).toContain("418");
  });
});

describe("the operator-facing error vocabulary", () => {
  it("translates every code the console route and the service can emit", () => {
    // The full set emitted by the route's pre-flight guards, the service's
    // management calls, and both validators. A code missing from the table
    // would reach the operator as a raw English token — the exact bug these
    // tests pin.
    const codes = [
      "ai_gateway_disabled",
      "ai_gateway_missing_master_key",
      "ai_gateway_virtual_keys_disabled",
      "ai_gateway_unreachable",
      "ai_gateway_auth",
      "ai_gateway_error",
      "ai_gateway_bad_response",
      ...validateGatewayInput({ baseUrl: "not-a-url" }),
    ];
    expect(new Set(codes).size).toBeGreaterThanOrEqual(6);
    for (const code of codes) {
      expect(gatewayErrorText(code), code).toBeTruthy();
    }
  });

  it("answers undefined for anything else, so the console shows its generic message", () => {
    expect(gatewayErrorText("totally_unknown_code")).toBeUndefined();
    expect(gatewayErrorText(undefined)).toBeUndefined();
    expect(gatewayErrorText("")).toBeUndefined();
  });

  it("reads the proxy's own explanation from every error shape LiteLLM uses", () => {
    // OpenAI shape: { error: { message } }
    expect(parseGatewayErrorDetail({ error: { message: "bad budget" } })).toBe("bad budget");
    // Plain string error
    expect(parseGatewayErrorDetail({ error: "nope" })).toBe("nope");
    // FastAPI shape: { detail } and { detail: [{ msg }] }
    expect(parseGatewayErrorDetail({ detail: "validation failed" })).toBe("validation failed");
    expect(parseGatewayErrorDetail({ detail: [{ msg: "field required" }] })).toBe("field required");
    // Nothing usable
    expect(parseGatewayErrorDetail(null)).toBeNull();
    expect(parseGatewayErrorDetail({})).toBeNull();
    expect(parseGatewayErrorDetail("text")).toBeNull();
    expect(parseGatewayErrorDetail({ error: { code: 500 } })).toBeNull();
  });

  it("truncates a runaway explanation so a console line stays a line", () => {
    expect(parseGatewayErrorDetail({ detail: "x".repeat(1000) })).toHaveLength(240);
  });

  it("attaches the explanation to the message with a visible separator", () => {
    expect(joinGatewayDetail("پیام", "why")).toBe("پیام — why");
    expect(joinGatewayDetail("پیام", null)).toBe("پیام");
    expect(joinGatewayDetail("پیام", undefined)).toBe("پیام");
  });
});

describe("the single billing architecture (migration 0168)", () => {
  // The platform console stopped mirroring the proxy's own settings: routing,
  // per-model RPM/TPM and per-key budgets live in docker/litellm/config.yaml
  // alone, and the Rial wallet is the only billing stop on the request path.
  // These greps pin the shape so a mirrored knob cannot quietly return.
  it("carries no routing/budget/limit fields in the stored gateway config", () => {
    const json = JSON.stringify(defaultGatewayConfig());
    for (const retired of ["routingStrategy", "defaultBudgetDuration", "maxBudgetUsd", "tpmLimit", "rpmLimit", "budgetDuration"]) {
      expect(json, retired).not.toContain(retired);
    }
  });

  it("exposes no routing/budget/limit fields in the public config either", () => {
    const json = JSON.stringify(toPublicGatewayConfig(gateway({ masterKey: "sk-secret" })));
    for (const retired of ["routingStrategy", "defaultMaxBudgetUsd", "defaultTpmLimit", "defaultRpmLimit", "budgetDuration"]) {
      expect(json, retired).not.toContain(retired);
    }
  });

  it("keeps a fresh business row identity-only — no model, budget, duration or rate limit columns", () => {
    const fresh = emptyBusinessGateway("b1");
    const json = JSON.stringify(fresh);
    for (const retired of ["maxBudgetUsd", "tpmLimit", "rpmLimit", "budgetDuration", "modelOverride"]) {
      expect(json, retired).not.toContain(retired);
    }
  });

  it("validates a gateway patch without any routing/budget/limit codes", () => {
    const codes = validateGatewayInput({ baseUrl: "http://litellm:4000/v1" });
    expect(codes).toEqual([]);
    expect(JSON.stringify(codes)).not.toMatch(/routing|budget|tpm|rpm|duration/);
  });
});

describe("validation", () => {
  it("rejects a base URL that is not a URL", () => {
    expect(validateGatewayInput({ baseUrl: "litellm:4000" })).toContain("ai_gateway_bad_base_url");
    expect(validateGatewayInput({ baseUrl: "http://litellm:4000/v1" })).not.toContain("ai_gateway_bad_base_url");
  });
});

describe("a fresh business/branch row", () => {
  it("is identity-only — no model, budget, duration or rate limit fields", () => {
    const row = emptyBusinessGateway("b1");
    expect(row.virtualKey).toBeNull();
    expect(row.spendUsd).toBe(0);
    expect(Object.keys(row).sort()).toEqual(
      ["businessId", "keyAlias", "locationId", "spendUsd", "syncedAt", "syncError", "virtualKey"].sort(),
    );
  });
});

describe("public shapes never leak credentials", () => {
  it("replaces the master key with a boolean", () => {
    const pub = toPublicGatewayConfig(gateway({ masterKey: "sk-secret" }));
    expect(pub.hasMasterKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("reports a missing master key as false rather than omitting the field", () => {
    expect(toPublicGatewayConfig(gateway({ masterKey: "" })).hasMasterKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 38b — costing from the gateway
// ---------------------------------------------------------------------------

describe("gateway cost capture and conversion", () => {
  it("reads the proxy's cost header and refuses nonsense", () => {
    expect(parseResponseCostHeader("0.00123")).toBe(0.00123);
    expect(parseResponseCostHeader("0")).toBe(0);
    expect(parseResponseCostHeader("")).toBeNull();
    expect(parseResponseCostHeader(null)).toBeNull();
    expect(parseResponseCostHeader("not-a-number")).toBeNull();
    expect(parseResponseCostHeader("-5")).toBeNull();
  });

  it("converts USD to whole Rial, rounding up once", () => {
    expect(rialFromGatewayUsd(0.5, 60_000)).toBe(30_000);
    expect(rialFromGatewayUsd(0.000001, 60_000)).toBe(1); // 0.06 Rial rounds up to 1
    expect(rialFromGatewayUsd(0, 60_000)).toBe(0);
    expect(rialFromGatewayUsd(-1, 60_000)).toBe(0);
    expect(rialFromGatewayUsd(1, 0)).toBe(0);
  });

  it("prices a turn at gateway cost plus margin, never below cost", () => {
    const pricing = gatewayTurnPricing(0.01, 100_000, 25);
    expect(pricing.costRial).toBe(1_000);
    expect(pricing.chargedRial).toBe(1_250);
  });

  it("zero margin sells at cost", () => {
    const pricing = gatewayTurnPricing(0.01, 100_000, 0);
    expect(pricing.chargedRial).toBe(pricing.costRial);
  });

  it("a fractional margin never sells below cost", () => {
    const pricing = gatewayTurnPricing(0.0001, 10_000, 0.1);
    expect(pricing.costRial).toBe(1);
    expect(pricing.chargedRial).toBeGreaterThanOrEqual(1);
  });

  it("no cost means no pricing — the token rates take over, never zero", () => {
    expect(gatewayTurnPricing(0, 100_000, 25).chargedRial).toBe(0);
    expect(gatewayTurnPricing(-1, 100_000, 25).costRial).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 38b / issue #748 P2-7 — MCP, fallback chains and model-access policy
// are LiteLLM's, never mirrored into the app's request body or stored config.
// ---------------------------------------------------------------------------

describe("the runtime never carries routing/MCP policy", () => {
  it("a gateway without extras sends an empty body", () => {
    const runtime = buildGatewayRuntime({
      config: platform,
      gateway: gateway(),
      business: null,
    });
    expect(runtime?.body).toEqual({});
  });
});

describe("validation after platform AI cleanup", () => {
  it("validates only technical LiteLLM connection fields on the AI page", () => {
    expect(validateGatewayInput({ baseUrl: "http://litellm:4000/v1", enabled: true, chatModel: "pos-chat" })).toEqual([]);
    expect(validateGatewayInput({ baseUrl: "http://litellm:4000/v1" })).toEqual([]);
  });

  it("still requires a chat model when enabling LiteLLM", () => {
    expect(validateGatewayInput({ enabled: true, baseUrl: "http://x", chatModel: "" })).toContain("ai_gateway_missing_chat_model");
  });
});

describe("the public gateway config is technical-only", () => {
  it("exposes LiteLLM connection fields but no billing, fallback or MCP controls", () => {
    const pub = toPublicGatewayConfig(
      gateway({
        masterKey: "sk-secret",
        gatewayCostingEnabled: true,
        usdRialRate: 60_000,
        revenueMarginPercent: 15,
        maxTurnRial: 40_000,
      }),
    );
    // Issue #812 §2/§6 — the managed-knowledge and Deep Research pointers are
    // technical connection state, so they belong here; the knowledge key does
    // NOT, only a boolean saying whether one is set.
    expect(pub).toEqual({
      enabled: true,
      baseUrl: "http://litellm:4000/v1",
      chatModel: "",
      embeddingModel: "",
      virtualKeysEnabled: false,
      hasMasterKey: true,
      knowledgeEnabled: false,
      knowledgeBaseUrl: "",
      knowledgeModel: "",
      knowledgeMaxResults: 8,
      hasKnowledgeApiKey: false,
      researchEnabled: false,
      researchModelAlias: "",
      researchMaxRounds: 12,
      researchMaxContextBytes: 2_000_000,
      researchTtlHours: 24,
      researchMaxSpendRial: 0,
      researchMinDataReadiness: 1,
      researchExternalWeb: false,
    });
    const json = JSON.stringify(pub);
    expect(json).not.toContain("sk-secret");
    expect(json).not.toMatch(/usdRialRate|revenueMarginPercent|maxTurnRial|fallbackModels|publishedModels|allowBusinessModels|mcpServers|mcpEnabled|modelOverride/);
  });
});
