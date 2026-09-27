import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as aiConfig from "@/lib/ai-config";
import * as aiRuntime from "@/lib/ai-runtime";
import * as aiMediaService from "@/lib/ai-media-service";
import * as mediaService from "@/lib/media-service";
import * as walletService from "@/lib/wallet-service";
import { POST } from "./route";

/**
 * The wallet-preflight-before-provider-cost pattern `enhance/route.ts`
 * already used, reused verbatim for upscale: refuse before the
 * provider call when the wallet plainly cannot cover the price, charge only
 * after bytes are in hand, and store the result as a new `upscaled`
 * derived asset — the source row is never touched.
 */

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/ai-config", () => ({
  isPlatformAiConfigured: vi.fn(() => true),
  logAiRuntimeUnavailable: vi.fn(() => "not_ready"),
}));

vi.mock("@/lib/ai-runtime", () => ({
  resolveAiConfigFor: vi.fn(async () => ({ baseUrl: "http://gw/v1", apiKey: "sk-1", model: "gpt-image-1" })),
}));

vi.mock("@/lib/ai-media-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-media-service")>();
  return { ...actual, runMediaUpscale: vi.fn() };
});

vi.mock("@/lib/media-service", () => ({
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(() => true),
  readMediaObject: vi.fn(),
  storeMediaAsset: vi.fn(),
}));

vi.mock("@/lib/wallet-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wallet-service")>();
  return { ...actual, getWalletBalanceRial: vi.fn(), chargeFeatureUse: vi.fn() };
});

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "user-1", role: "owner" };
const ASSET_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

function ctx() {
  return { params: Promise.resolve({ id: ASSET_ID }) };
}

function req(): NextRequest {
  return new Request(`http://localhost:3000/api/media/${ASSET_ID}/upscale`, { method: "POST" }) as unknown as NextRequest;
}

const STORED_ASSET = {
  id: ASSET_ID,
  kind: "image" as const,
  mimeType: "image/png",
  fileName: "product.png",
  folderId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(mediaService.getMediaConfig).mockResolvedValue({ enhancePriceRial: 5000, enhanceModel: "gpt-image-1" } as never);
  vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(true);
  vi.mocked(mediaService.readMediaObject).mockResolvedValue({ asset: STORED_ASSET, bytes: Buffer.from("x") } as never);
  vi.mocked(walletService.getWalletBalanceRial).mockResolvedValue(1_000_000);
  vi.mocked(walletService.chargeFeatureUse).mockResolvedValue(undefined as never);
  vi.mocked(mediaService.storeMediaAsset).mockResolvedValue({ id: "new-asset", variant: "upscaled" } as never);
});

describe("POST /api/media/[id]/upscale", () => {
  it("404s when the asset does not exist", async () => {
    vi.mocked(mediaService.readMediaObject).mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it("400s not_an_image for a document", async () => {
    vi.mocked(mediaService.readMediaObject).mockResolvedValue({ asset: { ...STORED_ASSET, kind: "document" }, bytes: Buffer.from("x") } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_an_image");
  });

  it("402s before ever calling the provider when the wallet cannot cover the price", async () => {
    vi.mocked(walletService.getWalletBalanceRial).mockResolvedValue(100);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(402);
    expect(aiMediaService.runMediaUpscale).not.toHaveBeenCalled();
  });

  it("stores the result as a new upscaled asset and charges the wallet only after success", async () => {
    vi.mocked(aiMediaService.runMediaUpscale).mockResolvedValue({ bytes: Buffer.from("png-bytes"), costUsd: 0.01 });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);

    const [storeArgs] = vi.mocked(mediaService.storeMediaAsset).mock.calls[0];
    expect(storeArgs).toMatchObject({ variant: "upscaled", sourceAssetId: ASSET_ID, mimeType: "image/png" });

    expect(walletService.chargeFeatureUse).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: "media_upscale", priceRial: 5000 }),
    );
  });

  it("maps a provider auth failure to 502 without ever charging the wallet", async () => {
    const { MediaAiError } = await import("@/lib/ai-media-service");
    vi.mocked(aiMediaService.runMediaUpscale).mockRejectedValue(new MediaAiError("ai_auth", "کلید نامعتبر است."));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(502);
    expect(walletService.chargeFeatureUse).not.toHaveBeenCalled();
  });

  it("503s when the platform AI runtime is not configured", async () => {
    vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(false);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(503);
    expect(mediaService.readMediaObject).toHaveBeenCalled();
    expect(aiRuntime.resolveAiConfigFor).toHaveBeenCalled();
  });
});
