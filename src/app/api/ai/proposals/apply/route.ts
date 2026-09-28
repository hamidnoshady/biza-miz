import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { aiActionPermission } from "@/lib/ai-capabilities";
import { isKnownAction, resolveActionEndpoint, ACTION_CATALOG, type ActionType } from "@/lib/ai";
import {
  claimAiActionAudit,
  finishAiActionAudit,
  getAiActionAuditStatus,
} from "@/lib/ai-action-audit";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * The only current confirmation endpoint for dashboard proposals.
 *
 * The audit row is claimed with a single SQL update before the existing
 * business route is called. A retry can therefore observe `processing` or a
 * terminal state but can never invoke a non-idempotent destination twice.
 * Destination routes remain the final domain authorization boundary.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;
  const canManage = guard.membership.permissions.has(PERMISSIONS.aiManage);

  const body = (await request.json().catch(() => ({}))) as { auditId?: unknown };
  const auditId = typeof body.auditId === "string" ? body.auditId.trim() : "";
  if (!auditId || auditId.length > 100) {
    return NextResponse.json({ error: "bad_request", message: "شناسهٔ پیشنهاد معتبر نیست." }, { status: 400 });
  }

  const claimed = await claimAiActionAudit({
    businessId: session.businessId,
    id: auditId,
    actorUserId: session.sub,
    canManage,
  });
  if (!claimed) {
    const status = await getAiActionAuditStatus(session.businessId, auditId, session.sub, canManage);
    if (!status) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(
      { error: "proposal_terminal", status, message: status === "processing" ? "این پیشنهاد در حال اجراست." : "این پیشنهاد قبلاً تعیین‌تکلیف شده و دوباره اجرا نمی‌شود." },
      { status: 409 },
    );
  }

  const actionType = claimed.actionType as ActionType;
  const meta = isKnownAction(actionType) ? ACTION_CATALOG[actionType] : null;
  const required = isKnownAction(actionType) ? aiActionPermission(actionType) : null;
  if (!meta || !required || !guard.membership.permissions.has(required)) {
    await finishAiActionAudit({
      businessId: session.businessId,
      id: auditId,
      status: "failed",
      result: { reason: "permission_denied" },
    });
    return NextResponse.json({ error: "forbidden", message: "دسترسی لازم برای اجرای این پیشنهاد را ندارید." }, { status: 403 });
  }

  const payload = claimed.payload && typeof claimed.payload === "object" && !Array.isArray(claimed.payload)
    ? claimed.payload
    : {};
  const endpoint = resolveActionEndpoint(meta, payload);
  if (!endpoint) {
    await finishAiActionAudit({ businessId: session.businessId, id: auditId, status: "failed", result: { reason: "missing_param" } });
    return NextResponse.json({ error: "missing_param", message: "اطلاعات لازم برای اجرای پیشنهاد کامل نیست." }, { status: 400 });
  }

  try {
    const destination = new URL(endpoint, request.url);
    const response = await fetch(destination, {
      method: meta.method,
      headers: {
        "Content-Type": "application/json",
        ...(request.headers.get("cookie") ? { cookie: request.headers.get("cookie")! } : {}),
        "X-AI-Proposal-Audit": auditId,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      await finishAiActionAudit({
        businessId: session.businessId,
        id: auditId,
        status: "failed",
        result: { endpoint, status: response.status, error: data.error ?? "destination_failed" },
      });
      return NextResponse.json(
        { error: "destination_failed", message: typeof data.message === "string" ? data.message : "ثبت پیشنهاد انجام نشد.", endpoint },
        { status: 422 },
      );
    }

    const auditPersisted = await finishAiActionAudit({
      businessId: session.businessId,
      id: auditId,
      status: "applied",
      result: { endpoint, status: response.status },
    });
    if (!auditPersisted) {
      // The business mutation already succeeded. Never turn it into a retryable
      // error: processing remains a hard no-retry barrier and operators can
      // reconcile the audit row from logs.
      console.error("ai proposal applied but audit finalization failed", { auditId, endpoint });
    }
    return NextResponse.json({ ok: true, endpoint, auditPersisted });
  } catch (error) {
    await finishAiActionAudit({
      businessId: session.businessId,
      id: auditId,
      status: "failed",
      result: { endpoint, reason: error instanceof Error ? error.message : "network_error" },
    }).catch(() => {});
    return NextResponse.json({ error: "destination_failed", message: "ارتباط با مسیر ثبت پیشنهاد برقرار نشد." }, { status: 502 });
  }
});
