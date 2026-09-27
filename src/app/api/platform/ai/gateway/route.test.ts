import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, POST } from "./route";
import { requirePlatformCapability } from "@/lib/platform-auth";
import { locationBelongsToBusiness, revokeVirtualKey } from "@/lib/ai-gateway-service";

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformCapability: vi.fn(async (cap: string) => {
    if (cap === "ai.read" || cap === "ai.config.manage") {
      return { session: { padmin: "admin-1", role: "owner" } };
    }
    return { error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
  }),
  requirePlatformAdmin: vi.fn(async () => ({ session: { padmin: "admin-1", role: "owner" } })),
  withPlatformScope: (fn: (req: NextRequest) => Promise<Response>) => fn,
  platformAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/ai-config", () => ({
  getPlatformAiConfig: vi.fn(async () => ({
    enabled: true,
    provider: "litellm",
    model: "pos-chat",
    baseUrl: "http://litellm:4000/v1",
    apiKey: "sk-master",
    maxOutputTokens: 1000,
    temperature: 0.3,
  })),
  getAiRuntimeReadiness: vi.fn(() => ({
    ready: true,
    reason: null,
    gatewayReady: true,
    authenticationReady: true,
    virtualKeyRequired: false,
    virtualKeyReady: true,
    modelReady: true,
  })),
}));

vi.mock("@/lib/ai-runtime", () => ({
  resolveAiConfigFor: vi.fn(async () => ({
    enabled: true,
    provider: "litellm",
    model: "pos-chat",
    baseUrl: "http://litellm:4000/v1",
    apiKey: "sk-tenant",
    maxOutputTokens: 1000,
    temperature: 0.3,
  })),
}));

vi.mock("@/lib/ai-gateway-service", () => ({
  getAiGatewayConfig: vi.fn(async () => ({
    enabled: true,
    baseUrl: "http://litellm:4000/v1",
    masterKey: "sk-master",
    chatModel: "pos-chat",
    embeddingModel: "pos-embed",
    virtualKeysEnabled: true,
    allowBusinessModels: true,
    publishedModels: ["pos-chat", "pos-fast"],
  })),
  listBusinessGateways: vi.fn(async () => [
    {
      id: "g-1",
      businessId: "biz-1",
      locationId: null,
      virtualKey: "sk-v1",
      keyAlias: "pos-biz1",
      modelOverride: null,
      spendUsd: 0,
      syncedAt: "2026-09-22T00:00:00Z",
      syncError: null,
    },
  ]),
  getBusinessGateway: vi.fn(async () => null),
  saveAiGatewayConfig: vi.fn(async (input) => ({
    enabled: Boolean(input.enabled),
    baseUrl: input.baseUrl ?? "http://litellm:4000/v1",
    masterKey: "sk-master",
    chatModel: input.chatModel ?? "pos-chat",
    embeddingModel: input.embeddingModel ?? "pos-embed",
    virtualKeysEnabled: Boolean(input.virtualKeysEnabled),
    allowBusinessModels: Boolean(input.allowBusinessModels),
    publishedModels: input.publishedModels ?? [],
  })),
  saveBusinessGateway: vi.fn(async (businessId, input) => ({
    id: "g-1",
    businessId,
    locationId: null,
    virtualKey: null,
    keyAlias: null,
    modelOverride: input.modelOverride ?? null,
    spendUsd: 0,
    syncedAt: null,
    syncError: null,
  })),
  provisionVirtualKey: vi.fn(async (_gw, input) => ({
    id: "g-1",
    businessId: input.businessId,
    locationId: null,
    virtualKey: "sk-new-key",
    keyAlias: `pos-${input.businessId}`,
    modelOverride: null,
    spendUsd: 0,
    syncedAt: "2026-09-22T00:00:00Z",
    syncError: null,
  })),
  revokeVirtualKey: vi.fn(async () => ({ ok: true, alreadyGone: false })),
  locationBelongsToBusiness: vi.fn(async () => true),
  BusinessLocationMismatchError: class extends Error {
    constructor() {
      super("ai_gateway_location_business_mismatch");
    }
  },
  refreshKeySpend: vi.fn(async () => ({
    id: "g-1",
    businessId: "biz-1",
    locationId: null,
    virtualKey: "sk-v1",
    keyAlias: "pos-biz1",
    modelOverride: null,
    spendUsd: 0.05,
    syncedAt: "2026-09-22T00:00:00Z",
    syncError: null,
  })),
  probeGateway: vi.fn(async () => ({
    ok: true,
    latencyMs: 42,
    models: ["pos-chat", "pos-fast"],
    stages: [
      { id: "liveliness", label: "دسترسی به سرور LiteLLM", ok: true },
      { id: "auth", label: "اعتبارسنجی کلید مدیر", ok: true },
      { id: "model", label: "بررسی نام مستعار مدل", ok: true },
      { id: "completion", label: "تست گفت‌وگو", ok: true },
      { id: "virtual_keys", label: "وضعیت کلیدهای مجازی", ok: true },
    ],
    error: null,
  })),
  mergeGatewayConfig: vi.fn((input, current) => ({ ...current, ...input })),
  toPublicAiGatewayConfig: vi.fn((gw) => ({
    enabled: gw.enabled,
    baseUrl: gw.baseUrl,
    chatModel: gw.chatModel,
    embeddingModel: gw.embeddingModel,
    virtualKeysEnabled: gw.virtualKeysEnabled,
    allowBusinessModels: gw.allowBusinessModels,
    publishedModels: gw.publishedModels,
    hasMasterKey: Boolean(gw.masterKey),
  })),
  toPublicBusinessGateway: vi.fn((row, _gw, model) => ({
    ...row,
    hasVirtualKey: Boolean(row.virtualKey),
    effectiveModel: row.modelOverride || model,
  })),
  GatewayProvisioningError: class extends Error {
    code: string;
    detail: string | null;
    constructor(code: string, detail: string | null = null) {
      super(code);
      this.code = code;
      this.detail = detail;
    }
  },
}));

vi.mock("@/lib/db", () => ({
  withoutTenantScope: vi.fn(async (_scope: string, fn: () => Promise<unknown>) => fn()),
  query: vi.fn(async (sql: string) => {
    if (sql.includes("locations")) {
      return { rows: [{ id: "loc-1", business_id: "biz-1", name: "شعبه مرکزی" }] };
    }
    if (sql.includes("businesses")) {
      return { rows: [{ id: "biz-1", name: "کافه تست", ai_entitled: true }] };
    }
    return { rows: [] };
  }),
}));

describe("GET /api/platform/ai/gateway", () => {
  it("returns technical gateway configuration and readiness without dead billing fields", async () => {
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.gateway).toMatchObject({
      enabled: true,
      baseUrl: "http://litellm:4000/v1",
      chatModel: "pos-chat",
      embeddingModel: "pos-embed",
      hasMasterKey: true,
    });
    // Ensure no dead billing fields are leaked
    expect(json.gateway.usdRialRate).toBeUndefined();
    expect(json.gateway.gatewayCostingEnabled).toBeUndefined();
    expect(json.gateway.maxTurnRial).toBeUndefined();
    expect(json.businessUsage).toBeUndefined();
    expect(json.platformRevenue).toBeUndefined();

    expect(json.runtimeReadiness.ready).toBe(true);
    expect(json.gateways).toHaveLength(1);
    expect(json.gateways[0].hasVirtualKey).toBe(true);
  });
});

describe("GET /api/platform/ai/gateway — read-only visibility (issue #748 P1-4)", () => {
  it("gives a read-only ai.read admin the same secret-safe technical state as an owner", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValueOnce({
      session: { padmin: "admin-2", role: "support" } as never,
      error: null,
    } as never);
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    // The public shape is already secret-safe — a read-only viewer must see
    // it too, not a null gateway that reads as "master key not registered".
    expect(json.gateway).toMatchObject({ hasMasterKey: true, baseUrl: "http://litellm:4000/v1" });
    expect(json.canManage).toBe(false);
    expect(JSON.stringify(json)).not.toContain("sk-master");
  });
});

describe("PUT /api/platform/ai/gateway", () => {
  it("runs the multi-stage probe when action is probe", async () => {
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "PUT",
      body: JSON.stringify({
        action: "probe",
        gateway: { baseUrl: "http://litellm:4000/v1" },
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status.ok).toBe(true);
    expect(json.status.stages).toHaveLength(5);
  });

  it("updates technical configuration when action is config", async () => {
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "PUT",
      body: JSON.stringify({
        action: "config",
        gateway: {
          enabled: true,
          baseUrl: "http://litellm:4000/v1",
          chatModel: "pos-chat",
          embeddingModel: "pos-embed",
          virtualKeysEnabled: true,
        },
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gateway.chatModel).toBe("pos-chat");
  });
});

describe("POST /api/platform/ai/gateway", () => {
  it("provisions a virtual key for a business", async () => {
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({
        action: "sync_key",
        businessId: "biz-1",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gateway.hasVirtualKey).toBe(true);
  });

  it("revokes a virtual key for a business", async () => {
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({
        action: "revoke_key",
        businessId: "biz-1",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("reports a non-2xx failure and never claims success when the remote revoke fails (issue #748 P0-1)", async () => {
    vi.mocked(revokeVirtualKey).mockResolvedValueOnce({
      ok: false,
      alreadyGone: false,
      code: "ai_gateway_unreachable",
      detail: null,
    });
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({ action: "revoke_key", businessId: "biz-1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("ai_gateway_unreachable");
  });

  it("rejects a location that does not belong to the business before any lifecycle action (issue #748 P0-3)", async () => {
    vi.mocked(locationBelongsToBusiness).mockResolvedValueOnce(false);
    const req = new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({ action: "sync_key", businessId: "biz-1", locationId: "loc-from-another-business" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("ai_gateway_location_business_mismatch");
  });
});
