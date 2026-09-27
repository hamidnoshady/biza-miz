import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as aiMediaService from "@/lib/ai-media-service";
import * as mediaService from "@/lib/media-service";
import * as walletService from "@/lib/wallet-service";
import { POST } from "./route";

/**
 * The one AI edit route with a genuinely different shape from
 * enhance/bg-remove/upscale: `runMediaVariations` can return more than one
 * image from a single provider call, so this route must create N asset rows
 * and charge N times the platform edit price for exactly the count the
 * provider actually returned — not the requested count, in case a provider
 * ever returns fewer than asked.
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
  return { ...actual, runMediaVariations: vi.fn() };
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
  return new Request(`http://localhost:3000/api/media/${ASSET_ID}/variations`, { method: "POST" }) as unknown as NextRequest;
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
  vi.mocked(walletService.getWalletBalanceRial).mockResolvedValue(10_000_000);
  vi.mocked(walletService.chargeFeatureUse).mockResolvedValue(undefined as never);
  let n = 0;
  vi.mocked(mediaService.storeMediaAsset).mockImplementation(async () => ({ id: `new-asset-${++n}`, variant: "variation" }) as never);
});

describe("POST /api/media/[id]/variations", () => {
  it("preflights the wallet against the full batch price (count × the platform edit price) before calling the provider", async () => {
    vi.mocked(walletService.getWalletBalanceRial).mockResolvedValue(5000); // covers 1, not 3
    const res = await POST(req(), ctx());
    expect(res.status).toBe(402);
    expect(aiMediaService.runMediaVariations).not.toHaveBeenCalled();
  });

  it("asks the provider for the fixed batch count, not a caller-supplied one", async () => {
    vi.mocked(aiMediaService.runMediaVariations).mockResolvedValue({ images: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")], costUsd: 0.03 });
    await POST(req(), ctx());
    const [callArgs] = vi.mocked(aiMediaService.runMediaVariations).mock.calls[0];
    expect(callArgs.count).toBe(3);
  });

  it("creates one derived asset per image the provider actually returned and charges for exactly that many", async () => {
    vi.mocked(aiMediaService.runMediaVariations).mockResolvedValue({ images: [Buffer.from("a"), Buffer.from("b")], costUsd: 0.02 }); // 2, not the requested 3
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.assets).toHaveLength(2);
    expect(mediaService.storeMediaAsset).toHaveBeenCalledTimes(2);
    for (const [args] of vi.mocked(mediaService.storeMediaAsset).mock.calls) {
      expect(args).toMatchObject({ variant: "variation", sourceAssetId: ASSET_ID });
    }
    expect(walletService.chargeFeatureUse).toHaveBeenCalledWith(
      expect.objectContaining({ featureKey: "media_variations", priceRial: 5000 * 2 }),
    );
  });

  it("charges nothing and stores nothing when the provider call fails", async () => {
    const { MediaAiError } = await import("@/lib/ai-media-service");
    vi.mocked(aiMediaService.runMediaVariations).mockRejectedValue(new MediaAiError("ai_network", "اتصال برقرار نشد."));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(504);
    expect(walletService.chargeFeatureUse).not.toHaveBeenCalled();
    expect(mediaService.storeMediaAsset).not.toHaveBeenCalled();
  });

  it("400s not_an_image for a document", async () => {
    vi.mocked(mediaService.readMediaObject).mockResolvedValue({ asset: { ...STORED_ASSET, kind: "document" }, bytes: Buffer.from("x") } as never);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_an_image");
  });
});
