import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT, POST } from "./route";
import { requirePlatformCapability } from "@/lib/platform-auth";
import {
  getAiGatewayRuntimeSettings,
  getAnyBusinessGatewayWithKey,
  listBusinessGatewaysForConsole,
  locationBelongsToBusiness,
  revokeVirtualKey,
} from "@/lib/ai-gateway-service";
import { query, withoutTenantScope } from "@/lib/db";

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformCapability: vi.fn(),
  requirePlatformAdmin: vi.fn(async () => ({ session: { padmin: "admin-1", role: "owner" } })),
  withPlatformScope: (fn: (req: NextRequest) => Promise<Response>) => fn,
  platformAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/ai-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-config")>("@/lib/ai-config");
  return { ...actual };
});

vi.mock("@/lib/ai-runtime", async () => {
  // The route decorates already-batched state in memory; keep that pure
  // implementation real so readiness tests exercise the branch resolver.
  const actual = await vi.importActual<typeof import("@/lib/ai-runtime")>("@/lib/ai-runtime");
  return { ...actual, resolveAiConfigFor: vi.fn() };
});

vi.mock("@/lib/ai-gateway-service", () => ({
  getAiGatewayConfig: vi.fn(),
  getAiGatewayRuntimeSettings: vi.fn(),
  getAnyBusinessGatewayWithKey: vi.fn(),
  getBusinessGateway: vi.fn(),
  listBusinessGatewaysForConsole: vi.fn(),
  saveAiGatewayConfig: vi.fn(),
  saveBusinessGateway: vi.fn(),
  provisionVirtualKey: vi.fn(),
  revokeVirtualKey: vi.fn(),
  rotateVirtualKey: vi.fn(),
  verifyVirtualKey: vi.fn(),
  locationBelongsToBusiness: vi.fn(),
  probeGateway: vi.fn(),
  mergeGatewayConfig: vi.fn(),
  toPublicAiGatewayConfig: vi.fn(),
  toPublicBusinessGateway: vi.fn(),
  BusinessLocationMismatchError: class extends Error {
    constructor() {
      super("ai_gateway_location_business_mismatch");
      this.name = "BusinessLocationMismatchError";
    }
  },
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
  withoutTenantScope: vi.fn(),
  query: vi.fn(),
}));

const platformConfig = {
  enabled: true,
  provider: "litellm",
  model: "pos-chat",
  baseUrl: "http://litellm:4000/v1",
  apiKey: "sk-master",
  maxOutputTokens: 1000,
  temperature: 0.3,
  inputCostRialPerMillion: 0,
  outputCostRialPerMillion: 0,
  revenueMarginPercent: 0,
  inputTokenRialPerMillion: 0,
  outputTokenRialPerMillion: 0,
  maxTurnRial: 0,
  creditUnitRial: 1,
  gatewayCostingEnabled: false,
  usdRialRate: null,
};

const gatewayConfig = {
  enabled: true,
  baseUrl: "http://litellm:4000/v1",
  masterKey: "sk-master",
  chatModel: "pos-chat",
  embeddingModel: "pos-embed",
  virtualKeysEnabled: true,
  usdRialRate: null,
  gatewayCostingEnabled: false,
  inputCostRialPerMillion: 0,
  outputCostRialPerMillion: 0,
  revenueMarginPercent: 0,
  maxTurnRial: 0,
  knowledgeEnabled: false,
  knowledgeBaseUrl: "",
  knowledgeApiKey: "",
  knowledgeModel: "",
  knowledgeMaxResults: 8,
  researchEnabled: false,
  researchModelAlias: "",
  researchMaxRounds: 12,
  researchMaxContextBytes: 2_000_000,
  researchTtlHours: 24,
  researchMaxSpendRial: 0,
  researchExternalWeb: false,
  researchMinDataReadiness: 1,
};

const businessKeyRow = {
  id: "g-biz-1",
  businessId: "biz-1",
  locationId: null,
  virtualKey: "sk-tenant-1",
  keyAlias: "pos-biz1",
  spendUsd: 0,
  syncedAt: "2026-09-22T00:00:00Z",
  syncError: null,
};

const defaultFleetRow = {
  total: 1,
  total_pages: 1,
  page: 1,
  business_id: "biz-1",
  business_name: "کافه تست",
  ai_entitled: true,
  business_has_key: true,
  has_branch_override: false,
  has_sync_error: false,
  has_branch_sync_error: false,
  fleet_status: "ready",
  is_focused: false,
};

const defaultLocationRow = {
  total: 1,
  total_pages: 1,
  page: 1,
  id: "loc-1",
  business_id: "biz-1",
  name: "شعبه مرکزی",
};

const probeStatus = {
  ok: true,
  latencyMs: 42,
  models: ["pos-chat", "pos-fast"],
  error: null,
  stages: [
    { key: "server", label: "دسترسی به سرور LiteLLM", ok: true, status: 200, model: null, message: null, detail: null },
    { key: "auth", label: "اعتبارسنجی کلید مدیر", ok: true, status: 200, model: null, message: null, detail: null },
    { key: "model_alias", label: "بررسی نام مستعار مدل", ok: true, status: 200, model: "pos-chat", message: null, detail: null },
    { key: "master_completion", label: "تست گفت‌وگو", ok: true, status: 200, model: "pos-chat", message: null, detail: null },
    { key: "virtual_key_completion", label: "وضعیت کلیدهای مجازی", ok: true, status: 200, model: "pos-chat", message: null, detail: null },
  ],
};

function fleetRow(overrides: Partial<typeof defaultFleetRow> = {}) {
  return { ...defaultFleetRow, ...overrides };
}

function locationRow(overrides: Partial<typeof defaultLocationRow> = {}) {
  return { ...defaultLocationRow, ...overrides };
}

function mockFleetQuery(rows: object[], locationRows?: object[]) {
  vi.mocked(query).mockResolvedValueOnce({ rows } as never);
  if (locationRows) vi.mocked(query).mockResolvedValueOnce({ rows: locationRows } as never);
}

beforeEach(async () => {
  vi.resetAllMocks();

  vi.mocked(requirePlatformCapability).mockImplementation(async (capability: string) => {
    if (capability === "ai.read" || capability === "ai.config.manage") {
      return { session: { padmin: "admin-1", role: "owner" }, error: null } as never;
    }
    return { error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) } as never;
  });
  vi.mocked(withoutTenantScope).mockImplementation(async (_scope, callback) => callback() as never);
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (sql.includes("WITH gateway_state")) return { rows: [fleetRow()] } as never;
    if (sql.includes("WITH target_business")) return { rows: [locationRow()] } as never;
    return { rows: [] } as never;
  });

  vi.mocked(getAiGatewayRuntimeSettings).mockResolvedValue({
    gateway: gatewayConfig,
    platform: platformConfig,
  } as never);
  vi.mocked(getAnyBusinessGatewayWithKey).mockResolvedValue(businessKeyRow as never);
  vi.mocked(listBusinessGatewaysForConsole).mockResolvedValue([businessKeyRow] as never);
  vi.mocked(locationBelongsToBusiness).mockResolvedValue(true);
  vi.mocked(revokeVirtualKey).mockResolvedValue({ ok: true, alreadyGone: false } as never);

  const service = vi.mocked(await import("@/lib/ai-gateway-service"));
  service.getAiGatewayConfig.mockResolvedValue(gatewayConfig as never);
  service.getBusinessGateway.mockResolvedValue(null);
  service.saveAiGatewayConfig.mockImplementation(async (input) => ({
    ...gatewayConfig,
    ...input,
    masterKey: "sk-master",
  }) as never);
  service.provisionVirtualKey.mockImplementation(async (_config: unknown, input: { businessId: string; locationId?: string | null }) => ({
    ...businessKeyRow,
    businessId: input.businessId,
    locationId: input.locationId ?? null,
  }) as never);
  service.probeGateway.mockResolvedValue(probeStatus as never);
  service.mergeGatewayConfig.mockImplementation((input, current) => ({ ...current, ...input }) as never);
  service.toPublicAiGatewayConfig.mockImplementation((config) => ({
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,
    virtualKeysEnabled: config.virtualKeysEnabled,
    hasMasterKey: Boolean(config.masterKey),
  }) as never);
  service.toPublicBusinessGateway.mockImplementation((row, _config, model) => ({
    businessId: row.businessId,
    locationId: row.locationId,
    keyAlias: row.keyAlias,
    syncedAt: row.syncedAt,
    syncError: row.syncError,
    hasVirtualKey: Boolean(row.virtualKey),
    effectiveModel: model,
  }) as never);
});

describe("GET /api/platform/ai/gateway", () => {
  it("returns secret-safe technical configuration and readiness from one fleet page", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.gateway).toMatchObject({
      enabled: true,
      baseUrl: "http://litellm:4000/v1",
      chatModel: "pos-chat",
      embeddingModel: "pos-embed",
      hasMasterKey: true,
    });
    expect(json.gateway.usdRialRate).toBeUndefined();
    expect(json.businessUsage).toBeUndefined();
    expect(json.platformRevenue).toBeUndefined();
    expect(json.runtimeReadiness.ready).toBe(true);
    expect(json.gateways).toEqual([
      expect.objectContaining({ businessId: "biz-1", hasVirtualKey: true, effectiveModel: "pos-chat" }),
    ]);
    expect(JSON.stringify(json)).not.toContain("sk-master");
    expect(JSON.stringify(json)).not.toContain("sk-tenant-1");
    expect(getAiGatewayRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(listBusinessGatewaysForConsole).toHaveBeenCalledTimes(1);

    const [fleetSql, values] = vi.mocked(query).mock.calls[0];
    expect(fleetSql).toContain("virtual_key_ciphertext");
    expect(fleetSql).not.toContain("virtual_key,");
    expect(fleetSql).toContain("LIMIT $7::int");
    expect(values).toEqual([true, false, true, "", "all", "", 20, 1]);
  });

  it("returns read-only ai.read visibility without enabling mutations", async () => {
    vi.mocked(requirePlatformCapability).mockResolvedValueOnce({
      session: { padmin: "admin-2", role: "support" },
      error: null,
    } as never);
    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gateway).toMatchObject({ hasMasterKey: true, baseUrl: "http://litellm:4000/v1" });
    expect(json.canManage).toBe(false);
  });

  it("fails closed when the singleton snapshot cannot be read", async () => {
    vi.mocked(getAiGatewayRuntimeSettings).mockRejectedValueOnce(new Error("db offline"));
    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("ai_configuration_load_failed");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("PUT /api/platform/ai/gateway", () => {
  it("runs the comprehensive probe using one selected tenant key", async () => {
    const res = await PUT(new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "PUT",
      body: JSON.stringify({ action: "probe", gateway: { baseUrl: "http://litellm:4000/v1" } }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).status.ok).toBe(true);
    expect(getAnyBusinessGatewayWithKey).toHaveBeenCalledTimes(1);
  });

  it("updates technical configuration when action is config", async () => {
    const res = await PUT(new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
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
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).gateway.chatModel).toBe("pos-chat");
  });
});

describe("POST /api/platform/ai/gateway", () => {
  it("provisions a virtual key for a business", async () => {
    const res = await POST(new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({ action: "sync_key", businessId: "biz-1" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).gateway.hasVirtualKey).toBe(true);
  });

  it("revokes a virtual key for a business", async () => {
    const res = await POST(new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({ action: "revoke_key", businessId: "biz-1" }),
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("reports a remote revoke failure as non-success", async () => {
    vi.mocked(revokeVirtualKey).mockResolvedValueOnce({
      ok: false,
      alreadyGone: false,
      code: "ai_gateway_unreachable",
      detail: null,
    } as never);
    const res = await POST(new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({ action: "revoke_key", businessId: "biz-1" }),
    }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("ai_gateway_unreachable");
  });

  it("rejects a location that does not belong to the business before a gateway call", async () => {
    vi.mocked(locationBelongsToBusiness).mockResolvedValueOnce(false);
    const res = await POST(new NextRequest("http://localhost:3000/api/platform/ai/gateway", {
      method: "POST",
      body: JSON.stringify({ action: "sync_key", businessId: "biz-1", locationId: "loc-other" }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("ai_gateway_location_business_mismatch");
    expect(getAiGatewayRuntimeSettings).not.toHaveBeenCalled();
  });
});

describe("fleet search, filtering and pagination (issue #757 P1-6)", () => {
  it("does server-side search/status filtering and page slicing with escaped LIKE values", async () => {
    mockFleetQuery([fleetRow({
      total: 3,
      total_pages: 3,
      page: 2,
      business_id: "biz-2",
      business_name: "Cafe 100!%_ Beta",
      ai_entitled: false,
      business_has_key: false,
      fleet_status: "entitlement_disabled",
    })]);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([]);

    const res = await GET(new NextRequest(
      `http://localhost:3000/api/platform/ai/gateway?pageSize=1&page=2&search=${encodeURIComponent("100!%_")}&status=entitlement_disabled`,
    ));
    const json = await res.json();
    expect(json.pagination).toEqual({ page: 2, pageSize: 1, total: 3, totalPages: 3 });
    expect(json.businesses).toEqual([
      { businessId: "biz-2", businessName: "Cafe 100!%_ Beta", aiEntitled: false },
    ]);

    const [sql, values] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("ILIKE $4::text ESCAPE '!'");
    expect(values).toEqual([true, false, true, "%100!!!%!_%", "entitlement_disabled", "", 1, 2]);
  });

  it("aggregates sync/branch state, and maps server status filters without an N+1 resolver", async () => {
    mockFleetQuery([fleetRow({
      fleet_status: "key_sync_error",
      has_sync_error: true,
      has_branch_override: true,
      has_branch_sync_error: true,
    })]);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([]);
    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?status=key_sync_error"));
    const json = await res.json();
    expect(json.tenantReadiness[0]).toMatchObject({
      businessId: "biz-1",
      status: "key_sync_error",
      hasBranchOverride: true,
      hasBranchSyncError: true,
    });
    expect(json.businesses).toHaveLength(1);
    expect(vi.mocked(query).mock.calls).toHaveLength(1);
  });

  it("keeps a focused business available for the branch panel without adding it to the fleet page", async () => {
    mockFleetQuery([
      fleetRow({ business_id: "biz-1", is_focused: false }),
      fleetRow({
        business_id: "biz-3",
        business_name: "رستوران گاما",
        is_focused: true,
      }),
    ], [locationRow({ business_id: "biz-3", id: "loc-3", name: "شعبه سوم" })]);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([]);

    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?pageSize=1&businessId=biz-3&locationId=loc-3"));
    const json = await res.json();
    expect(json.businesses.map((row: { businessId: string }) => row.businessId)).toEqual(["biz-1"]);
    expect(json.branchReadiness).toMatchObject({ businessId: "biz-3", locationId: "loc-3" });
    expect(listBusinessGatewaysForConsole).toHaveBeenCalledWith(
      ["biz-1", "biz-3"],
      { businessId: "biz-3", locationId: "loc-3" },
    );
  });

  it("paginates focused locations and binds exactly the placeholders used by SQL", async () => {
    mockFleetQuery([fleetRow()], [
      locationRow({ total: 120, total_pages: 3, page: 2, id: "loc-51", name: "شعبه پنجاه‌ویکم" }),
    ]);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([businessKeyRow]);
    const res = await GET(new NextRequest(
      `http://localhost:3000/api/platform/ai/gateway?businessId=biz-1&locationPage=2&locationPageSize=50&locationSearch=${encodeURIComponent("شعبه")}`,
    ));
    const json = await res.json();
    expect(json.locationPagination).toEqual({ page: 2, pageSize: 50, total: 120, totalPages: 3 });
    expect(json.locations).toEqual([{ id: "loc-51", businessId: "biz-1", name: "شعبه پنجاه‌ویکم" }]);
    const [sql, values] = vi.mocked(query).mock.calls[1];
    expect(sql).toContain("LIMIT $4::int");
    expect(values).toEqual(["biz-1", "%شعبه%", "", 50, 2]);
  });
});

describe("branch-scoped readiness (issue #757 P1-5)", () => {
  const locations = [
    locationRow({ id: "loc-1", name: "شعبه مرکزی" }),
    locationRow({ id: "loc-2", name: "شعبه دوم" }),
  ];

  it("reports an exact branch's own key, model, verification time and independent errors", async () => {
    mockFleetQuery([fleetRow({ has_branch_override: true, has_sync_error: true, has_branch_sync_error: true })], locations);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([
      businessKeyRow,
      {
        ...businessKeyRow,
        id: "g-branch-1",
        locationId: "loc-1",
        virtualKey: "sk-branch",
        keyAlias: "pos-biz1-loc1",
        syncedAt: "2026-10-01T12:00:00Z",
        syncError: "branch_sync_error",
      },
    ] as never);

    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?businessId=biz-1&locationId=loc-1"));
    const json = await res.json();
    expect(json.branchReadiness).toMatchObject({
      businessId: "biz-1",
      locationId: "loc-1",
      entitled: true,
      gatewayReady: true,
      credentialSource: "branch",
      businessHasKey: true,
      branchHasKey: true,
      inheritedFromBusiness: false,
      effectiveModel: "pos-chat",
      lastVerifiedAt: "2026-10-01T12:00:00Z",
      businessSyncError: null,
      branchSyncError: "branch_sync_error",
    });
    expect(JSON.stringify(json.branchReadiness)).not.toContain("sk-branch");
  });

  it("reports inherited business credentials separately from branch credentials", async () => {
    mockFleetQuery([fleetRow()], locations);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([businessKeyRow]);
    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?businessId=biz-1&locationId=loc-2"));
    const json = await res.json();
    expect(json.branchReadiness).toMatchObject({
      locationId: "loc-2",
      credentialSource: "business",
      businessHasKey: true,
      branchHasKey: false,
      inheritedFromBusiness: true,
      lastVerifiedAt: businessKeyRow.syncedAt,
    });
  });

  it("reports the master credential as effective when virtual keys are disabled", async () => {
    mockFleetQuery([fleetRow()], locations);
    vi.mocked(getAiGatewayRuntimeSettings).mockResolvedValueOnce({
      gateway: { ...gatewayConfig, virtualKeysEnabled: false },
      platform: platformConfig,
    } as never);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([
      businessKeyRow,
      { ...businessKeyRow, id: "g-branch-1", locationId: "loc-1", virtualKey: "sk-branch" },
    ] as never);

    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?businessId=biz-1&locationId=loc-1"));
    const json = await res.json();
    expect(json.branchReadiness).toMatchObject({
      credentialSource: "master",
      businessHasKey: true,
      branchHasKey: true,
      inheritedFromBusiness: false,
      lastVerifiedAt: null,
    });
  });

  it("does not describe a stored business key as inherited when tenant virtual keys are disabled", async () => {
    mockFleetQuery([fleetRow()], locations);
    vi.mocked(getAiGatewayRuntimeSettings).mockResolvedValueOnce({
      gateway: { ...gatewayConfig, virtualKeysEnabled: false },
      platform: platformConfig,
    } as never);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([businessKeyRow]);

    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?businessId=biz-1&locationId=loc-2"));
    expect((await res.json()).branchReadiness).toMatchObject({
      credentialSource: "master",
      businessHasKey: true,
      branchHasKey: false,
      inheritedFromBusiness: false,
    });
  });

  it("returns separate business and branch key-sync diagnostics", async () => {
    mockFleetQuery([fleetRow({ has_sync_error: true, has_branch_sync_error: true })], locations);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([
      { ...businessKeyRow, syncError: "business_sync_error" },
      { ...businessKeyRow, locationId: "loc-1", virtualKey: null, syncError: "branch_sync_error" },
    ] as never);
    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?businessId=biz-1&locationId=loc-1"));
    expect((await res.json()).branchReadiness).toMatchObject({
      businessSyncError: "business_sync_error",
      branchSyncError: "branch_sync_error",
      syncError: "branch_sync_error",
    });
  });

  it("returns no branch readiness for an unknown business/location pair", async () => {
    mockFleetQuery([fleetRow({ business_id: "biz-1" })], []);
    vi.mocked(listBusinessGatewaysForConsole).mockResolvedValueOnce([businessKeyRow]);
    const res = await GET(new NextRequest("http://localhost:3000/api/platform/ai/gateway?businessId=biz-1&locationId=loc-other"));
    expect((await res.json()).branchReadiness).toBeNull();
  });
});
