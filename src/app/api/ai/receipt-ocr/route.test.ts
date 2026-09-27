import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as aiConfig from "@/lib/ai-config";
import * as aiRuntime from "@/lib/ai-runtime";
import * as aiWalletBilling from "@/lib/ai-wallet-billing";
import * as receiptService from "@/lib/ai-receipt-service";
import * as mediaService from "@/lib/media-service";
import { POST } from "./route";

/**
 * Accounting's direct "upload a photo of a receipt" flow: permission →
 * storage-ready → format/size/signature validation → AI-config guard →
 * wallet gate (before the metered call) → the provider call → settle only on
 * success → persist the photo as a real Media asset (tenant-scoped dedup).
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
  resolveAiConfigFor: vi.fn(async () => ({ baseUrl: "http://gw/v1", apiKey: "sk-1", model: "gpt-4o-mini" })),
}));

vi.mock("@/lib/ai-wallet-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-wallet-billing")>();
  return { ...actual, gateAiTurn: vi.fn(), settleAiTurn: vi.fn(), newAiRequestId: () => "req-1" };
});

vi.mock("@/lib/ai-receipt-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-receipt-service")>();
  return { ...actual, runReceiptOcr: vi.fn() };
});

vi.mock("@/lib/media-service", () => ({
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(() => true),
  findMediaAssetByHash: vi.fn(),
  storeMediaAsset: vi.fn(),
}));

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "user-1", role: "owner" };

// A real, minimal 1x1 PNG — must pass hasMatchingMediaSignature("image/png", …).
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

function req(body: unknown): NextRequest {
  return new Request("http://localhost:3000/api/ai/receipt-ocr", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(mediaService.getMediaConfig).mockResolvedValue({} as never);
  vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(true);
  vi.mocked(mediaService.findMediaAssetByHash).mockResolvedValue(null);
  vi.mocked(mediaService.storeMediaAsset).mockResolvedValue({ id: "asset-1", fileName: "receipt.png" } as never);
  vi.mocked(aiWalletBilling.gateAiTurn).mockResolvedValue(undefined as never);
  vi.mocked(aiWalletBilling.settleAiTurn).mockResolvedValue({ chargedRial: 1200 } as never);
  vi.mocked(receiptService.runReceiptOcr).mockResolvedValue({
    fields: { vendor: "سوپرمارکت", expenseDate: "2026-01-05", amount: 100000, memo: "خرید", suggestedAccountCode: "5500" },
    usage: { inputTokens: 100, outputTokens: 20 },
    costUsd: 0.001,
  } as never);
});

describe("POST /api/ai/receipt-ocr", () => {
  it("503s when Media storage is not configured, before any AI call", async () => {
    vi.mocked(mediaService.isMediaStorageReady).mockReturnValue(false);
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(503);
    expect(receiptService.runReceiptOcr).not.toHaveBeenCalled();
  });

  it("400s attachment_invalid for an unsupported format", async () => {
    const res = await POST(req({ image: "data:text/plain;base64,aGVsbG8=" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("attachment_invalid");
  });

  it("400s signature_mismatch when the declared type and the bytes disagree", async () => {
    // Valid-shaped PNG data URL wrapper, but the payload is not real PNG bytes.
    const fakePng = `data:image/png;base64,${Buffer.from("not a real png").toString("base64")}`;
    const res = await POST(req({ image: fakePng }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("signature_mismatch");
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();
  });

  it("402s ai_credit_required before the provider is ever called when the wallet cannot cover a turn", async () => {
    const { AiWalletInsufficientError } = await import("@/lib/ai-wallet-billing");
    vi.mocked(aiWalletBilling.gateAiTurn).mockRejectedValue(new AiWalletInsufficientError(0, 0, 1000));
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(402);
    expect(receiptService.runReceiptOcr).not.toHaveBeenCalled();
  });

  it("on success: settles the wallet, stores the photo as a Media asset, and returns both fields and the asset", async () => {
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fields.vendor).toBe("سوپرمارکت");
    expect(json.asset).toMatchObject({ id: "asset-1" });
    expect(json.costRial).toBe(1200);

    expect(aiWalletBilling.settleAiTurn).toHaveBeenCalledTimes(1);
    const [storeArgs] = vi.mocked(mediaService.storeMediaAsset).mock.calls[0];
    expect(storeArgs).toMatchObject({ businessId: SESSION.businessId, kind: "image", mimeType: "image/png" });
  });

  it("reuses an existing asset by sha256 instead of storing a second copy of the same photo", async () => {
    vi.mocked(mediaService.findMediaAssetByHash).mockResolvedValue({ id: "existing-asset" } as never);
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.asset).toMatchObject({ id: "existing-asset" });
    expect(mediaService.storeMediaAsset).not.toHaveBeenCalled();
  });

  it("maps a provider failure to its HTTP status and settles nothing", async () => {
    const { ReceiptOcrError } = await import("@/lib/ai-receipt-service");
    vi.mocked(receiptService.runReceiptOcr).mockRejectedValue(new ReceiptOcrError("ai_auth", "کلید نامعتبر است."));
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(502);
    expect(aiWalletBilling.settleAiTurn).not.toHaveBeenCalled();
    expect(mediaService.storeMediaAsset).not.toHaveBeenCalled();
  });

  it("503s ai_unavailable when the platform AI runtime is not configured", async () => {
    vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(false);
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(503);
    expect(aiRuntime.resolveAiConfigFor).toHaveBeenCalled();
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();
  });
});
