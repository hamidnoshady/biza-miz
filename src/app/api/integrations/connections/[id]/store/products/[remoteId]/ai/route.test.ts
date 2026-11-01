import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/integrations/woo-product-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/woo-product-content")>();
  return { ...actual, wooProductContentFor: vi.fn() };
});
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/ai-runtime", () => ({ resolveAiConfigFor: vi.fn() }));
vi.mock("@/lib/ai-config", () => ({
  isPlatformAiConfigured: vi.fn(),
  logAiRuntimeUnavailable: vi.fn(() => "not_configured"),
}));
vi.mock("@/lib/ai-wallet-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-wallet-billing")>();
  return {
    ...actual,
    gateAiTurn: vi.fn(),
    settleAiTurn: vi.fn(),
    newAiRequestId: vi.fn(() => "req-1"),
  };
});
vi.mock("@/lib/ai-product-description-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-product-description-service")>();
  return { ...actual, runProductDescriptionDraft: vi.fn() };
});

import * as connectionAccess from "@/lib/integrations/connection-access";
import * as contentService from "@/lib/integrations/woo-product-content";
import * as setupState from "@/lib/setup-state";
import * as aiRuntime from "@/lib/ai-runtime";
import * as aiConfig from "@/lib/ai-config";
import * as wallet from "@/lib/ai-wallet-billing";
import * as describeService from "@/lib/ai-product-description-service";
import { POST } from "./route";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const CONNECTION_ID = "conn-woo-1";
const CONFIG = { model: "test-model", apiKey: "k" };

function wooConnection(overrides: Record<string, unknown> = {}) {
  return { id: CONNECTION_ID, business_id: SESSION.businessId, provider: "woocommerce", status: "active", link_mode: "plugin", ...overrides };
}

function content(overrides: Record<string, unknown> = {}) {
  return {
    remoteId: "55",
    localId: "local-uuid",
    name: "جاکفشی چوبی",
    sku: "SKU-1",
    wooType: "simple",
    remoteStatus: "publish",
    shortDescription: "کوتاه فروشگاه",
    description: "<p>بلند فروشگاه</p>",
    image: null,
    gallery: [],
    galleryCount: null,
    remoteModifiedAt: null,
    lastSeenAt: null,
    queue: null,
    ...overrides,
  };
}

function post(body: unknown, remoteId = "55") {
  return POST(
    new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/store/products/${remoteId}/ai`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: CONNECTION_ID, remoteId }) } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection() as never);
  vi.mocked(contentService.wooProductContentFor).mockResolvedValue(content() as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(aiRuntime.resolveAiConfigFor).mockResolvedValue(CONFIG as never);
  vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(true);
  vi.mocked(wallet.gateAiTurn).mockResolvedValue(undefined as never);
  vi.mocked(wallet.settleAiTurn).mockResolvedValue({ chargedRial: 1200 } as never);
  vi.mocked(describeService.runProductDescriptionDraft).mockResolvedValue({
    shortDescription: "کوتاه تازه",
    longDescription: "بلند تازه",
    usage: {},
    costUsd: 0.001,
  } as never);
});

describe("POST store/products/[remoteId]/ai — a metered draft that saves nothing", () => {
  it("guards the storefront ability, not the Accounting product workspace", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceManage);
    // The draft comes back as a suggestion; the route has no write path at all.
    expect(await res.json()).toEqual({
      ok: true,
      draft: { shortDescription: "کوتاه تازه", longDescription: "بلند تازه" },
      costRial: 1200,
    });
    expect(wallet.settleAiTurn).toHaveBeenCalledTimes(1);
  });

  it("tells the model the store's own facts, and the editor's unsaved text when sent", async () => {
    await post({ shortDescription: "", description: "متن در حال ویرایش", instruction: "کوتاه‌تر کن" });
    const facts = vi.mocked(describeService.runProductDescriptionDraft).mock.calls[0][0].facts;
    expect(facts.name).toBe("جاکفشی چوبی");
    expect(facts.sku).toBe("SKU-1");
    // An empty string from the editor is «this field is blank», not «use the
    // store's copy»: the human is looking at an empty box.
    expect(facts.existingShort).toBeNull();
    expect(facts.existingLong).toBe("متن در حال ویرایش");
    expect(facts.instruction).toBe("کوتاه‌تر کن");
  });

  it("falls back to the store's text on a first open", async () => {
    await post({});
    const facts = vi.mocked(describeService.runProductDescriptionDraft).mock.calls[0][0].facts;
    expect(facts.existingShort).toBe("کوتاه فروشگاه");
    expect(facts.existingLong).toBe("<p>بلند فروشگاه</p>");
  });

  it("charges the wallet only after a successful draft", async () => {
    vi.mocked(describeService.runProductDescriptionDraft).mockRejectedValue(
      new describeService.ProductDescriptionError("provider_failed", "provider said no"),
    );
    const res = await post({});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "ai_failed" });
    expect(wallet.settleAiTurn).not.toHaveBeenCalled();
  });

  it("refuses before spending anything when the platform AI is not configured", async () => {
    vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(false);
    const res = await post({});
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("ai_unavailable");
    expect(wallet.gateAiTurn).not.toHaveBeenCalled();
    expect(describeService.runProductDescriptionDraft).not.toHaveBeenCalled();
  });

  it("answers 402 when the AI wallet is empty, and never calls the model", async () => {
    vi.mocked(wallet.gateAiTurn).mockRejectedValue(new wallet.AiWalletInsufficientError(0, 0, 1200));
    const res = await post({});
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("ai_credit_required");
    expect(describeService.runProductDescriptionDraft).not.toHaveBeenCalled();
  });

  it("will not spend credit on a paused connection", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ status: "paused" }) as never);
    const res = await post({});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("connection_paused");
    expect(wallet.gateAiTurn).not.toHaveBeenCalled();
  });

  it("404s an unmapped product instead of drafting copy for an unknown item", async () => {
    vi.mocked(contentService.wooProductContentFor).mockResolvedValue(null as never);
    const res = await post({});
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("product_not_mapped");
  });

  it("refuses to invent copy for a product with no name", async () => {
    vi.mocked(contentService.wooProductContentFor).mockResolvedValue(content({ name: null }) as never);
    const res = await post({});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("product_name_unavailable");
    expect(describeService.runProductDescriptionDraft).not.toHaveBeenCalled();
  });

  it("bounds what the client may put in front of the model", async () => {
    await post({ instruction: "x".repeat(5000), description: "y".repeat(30000) });
    const facts = vi.mocked(describeService.runProductDescriptionDraft).mock.calls[0][0].facts;
    expect(facts.instruction).toHaveLength(200);
    expect(facts.existingLong).toHaveLength(20000);
  });
});
