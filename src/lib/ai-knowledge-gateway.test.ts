import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampKnowledgeLimit,
  formatKnowledgeForPrompt,
  isKnowledgeGatewayConfigured,
  knowledgeReadyFor,
  knowledgeSettingsFromConfig,
  retrieveTenantKnowledge,
  type KnowledgeGatewaySettings,
  type KnowledgeScope,
} from "./ai-knowledge-gateway";

const SETTINGS: KnowledgeGatewaySettings = {
  enabled: true,
  baseUrl: "http://litellm:4000/v1/knowledge",
  apiKey: "sk-knowledge",
  model: "",
  maxResults: 3,
};

const SCOPE: KnowledgeScope = {
  businessId: "biz-1",
  locationId: "loc-1",
  appKey: "accounting",
  projectId: null,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issue #812 §2 — the managed knowledge gateway", () => {
  it("is not configured until it has a base url and a key", () => {
    expect(isKnowledgeGatewayConfigured(SETTINGS)).toBe(true);
    expect(isKnowledgeGatewayConfigured({ ...SETTINGS, enabled: false })).toBe(false);
    expect(isKnowledgeGatewayConfigured({ ...SETTINGS, baseUrl: "  " })).toBe(false);
    expect(isKnowledgeGatewayConfigured({ ...SETTINGS, apiKey: "" })).toBe(false);
  });

  it("needs a business id as well as a configuration", () => {
    expect(knowledgeReadyFor(SETTINGS, "biz-1")).toBe(true);
    expect(knowledgeReadyFor(SETTINGS, null)).toBe(false);
    expect(knowledgeReadyFor(SETTINGS, "")).toBe(false);
  });

  it("clamps a caller-supplied limit into the configured window", () => {
    expect(clampKnowledgeLimit(99, SETTINGS.maxResults)).toBe(3);
    expect(clampKnowledgeLimit(0, SETTINGS.maxResults)).toBe(1);
    expect(clampKnowledgeLimit("nonsense", SETTINGS.maxResults)).toBe(3);
    expect(clampKnowledgeLimit(2, SETTINGS.maxResults)).toBe(2);
  });

  it("reads its settings off the resolved gateway config, never off a caller", () => {
    const settings = knowledgeSettingsFromConfig({
      enabled: true,
      provider: "litellm",
      model: "pos-chat",
      baseUrl: "http://litellm:4000/v1",
      apiKey: "sk-tenant",
      temperature: 0.3,
      knowledge: { enabled: true, baseUrl: "http://k", apiKey: "sk-k", model: "m", maxResults: 5 },
    });
    expect(settings).toEqual({
      enabled: true,
      baseUrl: "http://k",
      apiKey: "sk-k",
      model: "m",
      maxResults: 5,
    });
  });

  it("degrades to an empty retrieval when nothing is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await retrieveTenantKnowledge(
      { ...SETTINGS, enabled: false },
      SCOPE,
      "قیمت قهوه",
    );
    expect(result).toEqual({ hits: [], inputTokens: 0, costUsd: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the tenant as a PATH SEGMENT and in the metadata, on every request", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ hits: [{ source_type: "item", source_ref: "i1", title: "قهوه", content: "۳۵ هزار", similarity: 0.9 }] }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await retrieveTenantKnowledge(SETTINGS, SCOPE, "قیمت قهوه");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    // The tenant is a PATH SEGMENT, not a query parameter: a gateway that
    // partitions by namespace cannot then serve a request that forgot to name
    // one, and a mistaken prefix is a 404 rather than another tenant's rows.
    expect(url).toBe("http://litellm:4000/v1/knowledge/biz-1/search");
    const body = JSON.parse(String(init.body)) as {
      metadata?: Record<string, string>;
      query?: string;
      limit?: number;
    };
    // The tenant is stated twice on purpose: path segment and metadata. A
    // gateway reading either one alone still lands in the right namespace.
    expect(body.metadata?.business_id).toBe("biz-1");
    expect(body.metadata?.location_id).toBe("loc-1");
    expect(body.metadata?.app_key).toBe("accounting");
    expect(body.query).toBe("قیمت قهوه");
    expect(body.limit).toBe(3);
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-knowledge" });
  });

  it("refuses to search at all without a tenant", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await retrieveTenantKnowledge(SETTINGS, { ...SCOPE, businessId: "" }, "قهوه");
    expect(result.hits).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an empty retrieval rather than throwing when the gateway fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await retrieveTenantKnowledge(SETTINGS, SCOPE, "قهوه");
    expect(result).toEqual({ hits: [], inputTokens: 0, costUsd: null });
  });

  it("returns an empty retrieval rather than throwing on a 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 })),
    );
    const result = await retrieveTenantKnowledge(SETTINGS, SCOPE, "قهوه");
    expect(result.hits).toEqual([]);
  });

  it("formats hits with their source, so an answer can cite it", () => {
    const text = formatKnowledgeForPrompt([
      {
        sourceType: "item",
        sourceRef: "i1",
        title: "قهوه ترک",
        content: "۳۵ هزار تومان",
        similarity: 0.91,
      },
    ]);
    expect(text).toContain("قهوه ترک");
    expect(text).toContain("۳۵ هزار تومان");
    // The source type is carried so a citation says what kind of thing it was.
    expect(text).toContain("[item:");
  });
});
