import { NextRequest, NextResponse } from "next/server";
import {
  requireAnyPermission,
  requirePermission,
  withTenantScope,
} from "@/lib/auth";
import {
  finishAiActionAudit,
  listAiActionAudit,
  type AiActionAuditTerminalStatus,
} from "@/lib/ai-action-audit";
import { PERMISSIONS } from "@/lib/permissions";

const TERMINAL_STATUSES: AiActionAuditTerminalStatus[] = [
  "applied",
  "failed",
  "dismissed",
  "reverted",
];

/** Members with AI usage/audit capability can review only their own proposals;
 * AI managers can review the tenant-wide activity. */
export const GET = withTenantScope(async () => {
  const guard = await requireAnyPermission(PERMISSIONS.aiUsageView, PERMISSIONS.aiManage);
  if (guard.error) return guard.error;
  const entries = await listAiActionAudit(
    guard.session.businessId,
    30,
    guard.membership.permissions.has(PERMISSIONS.aiManage) ? undefined : guard.session.sub,
  );
  return NextResponse.json({ entries });
});

/**
 * The browser calls this only after the already-role-guarded destination action
 * responds. It cannot create an audit row or forge another tenant's row: rows
 * originate in the server-side chat route and remain protected by RLS.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;

  let body: { id?: unknown; status?: unknown; result?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const status =
    typeof body.status === "string" &&
    TERMINAL_STATUSES.includes(body.status as AiActionAuditTerminalStatus)
      ? (body.status as AiActionAuditTerminalStatus)
      : null;
  if (!id || id.length > 100 || !status) {
    return NextResponse.json({ error: "invalid_audit_update" }, { status: 400 });
  }
  const result =
    body.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? (body.result as Record<string, unknown>)
      : undefined;

  const updated = await finishAiActionAudit({
    businessId: guard.session.businessId,
    id,
    status,
    result,
    actorUserId: guard.membership.permissions.has(PERMISSIONS.aiManage) ? undefined : guard.session.sub,
  });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
