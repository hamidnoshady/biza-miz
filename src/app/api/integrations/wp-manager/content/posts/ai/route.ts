import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isPlatformAiConfigured, logAiRuntimeUnavailable } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { AiWalletInsufficientError, gateAiTurn, newAiRequestId, settleAiTurn } from "@/lib/ai-wallet-billing";
import { EditorialError, runEditorialDraft } from "@/lib/editorial-ai-service";
import {
  EDITORIAL_LIMITS,
  isEditorialAction,
  isEditorialLanguage,
  isEditorialTone,
  type EditorialRequest,
} from "@/lib/editorial-ai";

/**
 * The editorial assistant: one metered drafting turn for a post or a page
 * (issue #1215, P2‑5).
 *
 * Two things this route deliberately does **not** do:
 *
 *  - **It does not write.** No WordPress call, no queue event, no mirror row.
 *    The draft goes back to the editor, the human reads it, and it reaches the
 *    site only through `POST /content/posts` — which keeps its version check,
 *    its plugin/REST transport and its audit trail. «مدل ذخیره نمی‌کند.»
 *  - **It does not need the Accounting product workspace.** The ability is the
 *    one that already owns store content, `woocommerce.manage`, so the same
 *    member who may edit a page may ask for a draft of it. The AI conventions
 *    are the platform's own: config guard → wallet reserve → provider call →
 *    settle on success only.
 */
function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;

  const connectionId = typeof raw.connectionId === "string" ? raw.connectionId : "";
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  if (raw.type !== "post" && raw.type !== "page") {
    return NextResponse.json({ error: "invalid_content_type" }, { status: 400 });
  }
  if (!isEditorialAction(raw.action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  if (raw.tone !== undefined && raw.tone !== null && !isEditorialTone(raw.tone)) {
    return NextResponse.json({ error: "invalid_tone" }, { status: 400 });
  }
  if (raw.language !== undefined && raw.language !== null && !isEditorialLanguage(raw.language)) {
    return NextResponse.json({ error: "invalid_language" }, { status: 400 });
  }

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // A paused connection is read-only by definition: spending credit on a draft
  // that could not be saved would be a charge with no possible outcome.
  if (connection.status === "paused") {
    return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  }

  const editorialRequest: EditorialRequest = {
    action: raw.action,
    title: bounded(raw.title, EDITORIAL_LIMITS.title),
    content: bounded(raw.content, EDITORIAL_LIMITS.content),
    excerpt: bounded(raw.excerpt, EDITORIAL_LIMITS.excerpt),
    keywords: bounded(raw.keywords, EDITORIAL_LIMITS.keywords),
    instruction: bounded(raw.instruction, EDITORIAL_LIMITS.instruction),
    tone: isEditorialTone(raw.tone) ? raw.tone : null,
    language: isEditorialLanguage(raw.language) ? raw.language : null,
  };
  // Every action except a from-scratch outline needs *something* to work on;
  // asking the model to improve an empty page is how invented copy appears.
  const hasMaterial = Boolean(editorialRequest.title || editorialRequest.content || editorialRequest.excerpt);
  if (editorialRequest.action !== "outline" && editorialRequest.action !== "body" && !hasMaterial) {
    return NextResponse.json({ error: "empty_content" }, { status: 400 });
  }
  if ((editorialRequest.action === "outline" || editorialRequest.action === "body") && !editorialRequest.title) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location", message: "شعبه‌ای ثبت نشده است." }, { status: 409 });
  }

  const config = await resolveAiConfigFor(session.businessId, location.id, { ensureVirtualKey: true });
  if (!isPlatformAiConfigured(config)) {
    const reason = logAiRuntimeUnavailable(config, {
      businessId: session.businessId,
      locationId: location.id,
      surface: "editorial_draft",
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

  try {
    const result = await runEditorialDraft({ config, request: editorialRequest });
    const settlement = await settleAiTurn({
      businessId: session.businessId,
      requestId,
      config,
      usage: result.usage,
      costUsd: result.costUsd,
      attribution: {
        requestType: "editorial_draft",
        model: config.model,
        locationId: location.id,
        userId: session.sub,
        // The ledger names the store and the content type the credit was spent
        // on — never the text itself.
        metadata: { kind: "editorial_draft", connectionId, contentType: raw.type, action: editorialRequest.action },
      },
    });
    return NextResponse.json({
      ok: true,
      // The draft is text only; the editor decides what to do with it.
      draft: { text: result.text },
      action: editorialRequest.action,
      costRial: settlement.chargedRial,
    });
  } catch (err) {
    // A failed turn settles nothing (no reservation was made to refund).
    if (err instanceof EditorialError) {
      return NextResponse.json({ error: "ai_failed", message: "تولید پیش‌نویس ناموفق بود. دوباره تلاش کنید." }, { status: 502 });
    }
    console.error("wp_editorial_ai_failed", { connectionId, error: (err as Error).message });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
});
