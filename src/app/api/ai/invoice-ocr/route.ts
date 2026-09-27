import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { parseReceiptImageDataUrl } from "@/lib/ai-receipt";
import { InvoiceOcrError, runInvoiceOcr } from "@/lib/ai-invoice-ocr-service";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";
import { hasMatchingMediaSignature } from "@/lib/media";
import {
  findMediaAssetByHash,
  getMediaConfig,
  isMediaStorageReady,
  storeMediaAsset,
} from "@/lib/media-service";

/**
 * Metered supplier-invoice OCR.
 *
 * Owner/manager only (same scope as purchases). Order mirrors
 * `/api/ai/receipt-ocr`, its Accounting twin: permission → storage ready →
 * input validation (format, size, byte-signature) → an active location →
 * AI-config guard → wallet gate (reserve) → the metered provider call →
 * settle (only on success) → persist the invoice photo as a real Media asset
 * (tenant-scoped SHA-256 dedup, `source: "ocr_invoice"`, migration 0180) so
 * the purchases form can attach it to the draft it produces
 * (`purchases.invoice_asset_id`, migration 0179) the same way Accounting
 * already attaches a receipt photo to its expense. This closes the storage
 * half of what used to be a deliberately ephemeral, non-persisting design —
 * the extraction/matching logic underneath is unchanged.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager();
  if (guard.error) return guard.error;
  const session = guard.session;

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
  const dataUrl =
    typeof rawImage === "string"
      ? rawImage
      : rawImage && typeof rawImage === "object" && typeof (rawImage as { dataUrl?: unknown }).dataUrl === "string"
        ? ((rawImage as { dataUrl: string }).dataUrl)
        : null;

  const parsed = parseReceiptImageDataUrl(dataUrl);
  if (!parsed) {
    return NextResponse.json(
      { error: "attachment_invalid", message: "فرمت یا حجم تصویر فاکتور پشتیبانی نمی‌شود." },
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

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location", message: "شعبه‌ای ثبت نشده است." }, { status: 409 });
  }

  const config = await resolveAiConfigFor(session.businessId, location.id, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, { businessId: session.businessId, locationId: location.id, surface: "invoice_ocr" });
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

  try {
    const result = await runInvoiceOcr({
      config,
      locationId: location.id,
      dataUrl: parsed.dataUrl,
    });

    const settlement = await settleAiTurn({
      businessId: session.businessId,
      requestId,
      config,
      usage: result.usage,
      costUsd: result.costUsd,
      attribution: {
        requestType: "ocr",
        model: config.model,
        locationId: location.id,
        userId: session.sub,
        metadata: { kind: "invoice_ocr" },
      },
    });

    // The invoice photo itself becomes a real, permanent Media asset — the
    // storage gap this route used to leave open — with the library's own
    // tenant-scoped dedup so re-scanning the same photo never writes a
    // second copy. Charged/settled above regardless, since extraction
    // already succeeded; a storage hiccup here must not undo that.
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = await findMediaAssetByHash(session.businessId, sha256).catch(() => null);
    const fileName =
      (typeof body.fileName === "string" && body.fileName.trim().slice(0, 200)) ||
      `invoice.${parsed.mimeType === "image/png" ? "png" : parsed.mimeType === "image/webp" ? "webp" : "jpg"}`;
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
        source: "ocr_invoice",
      }));

    return NextResponse.json({
      ok: true,
      extraction: result.extraction,
      lines: result.lines,
      validation: result.validation,
      supplierId: result.supplierId,
      supplierName: result.supplierName,
      usage: result.usage,
      costRial: settlement.chargedRial,
      asset,
    });
  } catch (err) {
    // Phase B — no reservation to refund; a failed turn settles nothing.
    if (err instanceof InvoiceOcrError) {
      const status =
        err.code === "ai_auth" ? 502 : err.code === "ai_timeout" || err.code === "ai_network" ? 504 : 422;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }
});
