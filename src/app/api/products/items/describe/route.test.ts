import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as aiConfig from "@/lib/ai-config";
import * as aiWalletBilling from "@/lib/ai-wallet-billing";
import * as descriptionService from "@/lib/ai-product-description-service";
import * as auth from "@/lib/auth";
import * as industry from "@/lib/industry-guard";
import * as setupState from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

/**
 * AI product-description drafts: permission → industry → branch → AI-config
 * guard → wallet gate (before the metered call) → the provider call → settle
 * only on success. The route returns text and writes nothing.
 */
vi.mock("@/lib/auth", () => ({
  requireAnyPermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/ai-config", () => ({
  isPlatformAiConfigured: vi.fn(() => true),
  logAiRuntimeUnavailable: vi.fn(() => "not_ready"),
}));
vi.mock("@/lib/ai-runtime", () => ({
  resolveAiConfigFor: vi.fn(async () => ({ baseUrl: "http://gw/v1", apiKey: "sk-1", model: "gpt-4o-mini" })),
}));
vi.mock("@/lib/ai-wallet-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-wallet-billing")>();
  return { ...actual, gateAiTurn: vi.fn(), settleAiTurn: vi.fn(), newAiRequestId: () => "req-1" };
});
vi.mock("@/lib/ai-product-description-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-product-description-service")>();
  return { ...actual, runProductDescriptionDraft: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function req(body: unknown): NextRequest {
  return new Request("http://localhost:3000/api/products/items/describe", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(industry.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(true);
  vi.mocked(aiWalletBilling.gateAiTurn).mockResolvedValue(undefined as never);
  vi.mocked(aiWalletBilling.settleAiTurn).mockResolvedValue({ chargedRial: 1200 } as never);
  vi.mocked(descriptionService.runProductDescriptionDraft).mockResolvedValue({
    shortDescription: "کوتاه",
    longDescription: "کامل",
    usage: { inputTokens: 10, outputTokens: 20 },
    costUsd: 0.001,
  });
});

describe("POST /api/products/items/describe", () => {
  it("returns a draft, settles the turn once, and writes nothing", async () => {
    const response = await POST(req({ name: " دستبند ", sku: "B-1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      draft: { shortDescription: "کوتاه", longDescription: "کامل" },
      costRial: 1200,
    });
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust, PERMISSIONS.menuEdit);
    expect(descriptionService.runProductDescriptionDraft).toHaveBeenCalledWith(
      expect.objectContaining({ facts: expect.objectContaining({ name: "دستبند", sku: "B-1" }) }),
    );
    expect(aiWalletBilling.settleAiTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiWalletBilling.settleAiTurn).mock.calls[0][0]).toMatchObject({
      businessId: "biz-1",
      attribution: { requestType: "product_description" },
    });
  });

  it("refuses an industry without the products workspace before touching the AI", async () => {
    vi.mocked(industry.requireProductWorkspaceForApi).mockResolvedValue(
      Response.json({ error: "industry_mismatch" }, { status: 403 }) as never,
    );
    const response = await POST(req({ name: "کالا" }));
    expect(response.status).toBe(403);
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();
  });

  it("needs a product name, and bounds what it forwards to the model", async () => {
    expect((await POST(req({ name: "   " }))).status).toBe(400);
    expect((await POST(req("not json"))).status).toBe(400);
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();

    await POST(
      req({
        name: "x".repeat(500),
        attributes: Array.from({ length: 50 }, (_, index) => ({ name: `n${index}`, value: "v" })),
        instruction: "y".repeat(500),
      }),
    );
    const facts = vi.mocked(descriptionService.runProductDescriptionDraft).mock.calls[0][0].facts;
    expect(facts.name).toHaveLength(200);
    expect(facts.attributes).toHaveLength(20);
    expect(facts.instruction).toHaveLength(200);
  });

  it("answers 503 when the platform AI is not ready, and 402 when the wallet cannot cover it", async () => {
    vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(false);
    expect((await POST(req({ name: "کالا" }))).status).toBe(503);
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();

    vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(true);
    vi.mocked(aiWalletBilling.gateAiTurn).mockRejectedValue(new aiWalletBilling.AiWalletInsufficientError(0, 0, 1));
    const response = await POST(req({ name: "کالا" }));
    expect(response.status).toBe(402);
    expect(descriptionService.runProductDescriptionDraft).not.toHaveBeenCalled();
  });

  it("settles nothing when the provider fails", async () => {
    vi.mocked(descriptionService.runProductDescriptionDraft).mockRejectedValue(
      new descriptionService.ProductDescriptionError("ai_timeout", "timeout"),
    );
    const response = await POST(req({ name: "کالا" }));
    expect(response.status).toBe(504);
    expect(aiWalletBilling.settleAiTurn).not.toHaveBeenCalled();
  });
});
