import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { MAX_RECEIPT_IMAGE_BYTES, parseReceiptImageDataUrl } from "@/lib/ai-receipt";
import { ReceiptOcrError, runReceiptOcr } from "@/lib/ai-receipt-service";
import { hasMatchingMediaSignature } from "@/lib/media";
import {
  findMediaAssetByHash,
  getMediaConfig,
  isMediaStorageReady,
  storeMediaAsset,
} from "@/lib/media-service";

/**
 * Accounting's direct "upload a photo of a receipt" flow — as distinct from
 * the AI Chat assistant's `draft_expense_from_receipt` tool, which does the
 * same extraction but only inside a chat turn. This is the entry point named
 * in the platform Media report as missing: Accounting had zero non-chat OCR
 * affordance, and the chat path never persisted the photo anywhere.
 *
 * Order mirrors every other metered AI route this program has built
 * (`/api/ai/invoice-ocr`, `/api/media/[id]/enhance`): permission → storage
 * ready → input validation (format, size, byte-signature — the same
 * fail-closed check every other Media entry point applies, since this photo
 * is about to become a real, permanent Media asset, not an ephemeral chat
 * attachment) → AI-config guard → wallet gate (reserve) → the metered
 * provider call → settle (only on success) → persist the asset (tenant-scoped
 * SHA-256 dedup, same as a manual `POST /api/media` upload) → return both the
 * extracted fields and the stored asset so the caller can prefill the expense
 * form AND show/link the receipt photo.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
  if (error) return error;

  const mediaConfig = await getMediaConfig();
  if (!isMediaStorageReady(mediaConfig)) {
    return NextResponse.json({ error: "storage_not_configured" }, { status: 503 });
  }

  let body: { image?: unknown; dataUrl?: unknown; fileName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rawImage = body.image ?? body.dataUrl;
  const parsed = parseReceiptImageDataUrl(typeof rawImage === "string" ? rawImage : null);
  if (!parsed) {
    return NextResponse.json(
      {
        error: "attachment_invalid",
        message: `فرمت یا حجم تصویر رسید پشتیبانی نمی‌شود (حداکثر ${Math.round(MAX_RECEIPT_IMAGE_BYTES / (1024 * 1024))} مگابایت، JPEG/PNG/WebP).`,
      },
      { status: 400 },
    );
  }

  const base64 = parsed.dataUrl.slice(parsed.dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength === 0 || !hasMatchingMediaSignature(parsed.mimeType, bytes)) {
    return NextResponse.json(
      { error: "signature_mismatch", message: "محتوای تصویر با نوع اعلام‌شدهٔ آن نمی‌خواند." },
      { status: 400 },
    );
  }

  const config = await resolveAiConfigFor(session.businessId, null, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, {
      businessId: session.businessId,
      locationId: null,
      surface: "receipt_ocr",
    });
    return NextResponse.json(
      { error: "ai_unavailable", reason, message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  const requestId = newAiRequestId();
  try {
    await gateAiTurn(session.businessId, config);
  } catch (err) {
    if (err instanceof AiWalletInsufficientError) {
      return NextResponse.json(
        { error: "ai_credit_required", message: "اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید." },
        { status: 402 },
      );
    }
    throw err;
  }

  let extraction: Awaited<ReturnType<typeof runReceiptOcr>>;
  try {
    extraction = await runReceiptOcr({ config, dataUrl: parsed.dataUrl });
  } catch (err) {
    // Mirrors /api/ai/invoice-ocr: no reservation to refund — a failed turn
    // settles nothing, so nothing is charged for a call that produced no
    // usable result.
    if (err instanceof ReceiptOcrError) {
      const status =
        err.code === "ai_auth" ? 502
        : err.code === "ai_timeout" || err.code === "ai_network" ? 504
        : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }

  const settlement = await settleAiTurn({
    businessId: session.businessId,
    requestId,
    config,
    usage: extraction.usage,
    costUsd: extraction.costUsd,
    attribution: {
      requestType: "ocr",
      model: config.model,
      locationId: null,
      userId: session.sub,
      metadata: { kind: "receipt_ocr" },
    },
  });

  // The receipt photo itself becomes a real, permanent Media asset — the gap
  // this route was built to close — with the library's own tenant-scoped
  // dedup so re-submitting the same photo never writes a second copy.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = await findMediaAssetByHash(session.businessId, sha256).catch(() => null);
  const fileName =
    (typeof body.fileName === "string" && body.fileName.trim().slice(0, 200)) ||
    `receipt.${parsed.mimeType === "image/png" ? "png" : parsed.mimeType === "image/webp" ? "webp" : "jpg"}`;
  const asset =
    existing ??
    (await storeMediaAsset({
      businessId: session.businessId,
      userId: session.sub,
      config: mediaConfig,
      kind: "image",
      fileName,
      mimeType: parsed.mimeType,
      bytes,
      sha256,
      source: "ocr_receipt",
    }));

  return NextResponse.json({
    ok: true,
    fields: extraction.fields,
    asset,
    usage: extraction.usage,
    costRial: settlement.chargedRial,
  });
});
