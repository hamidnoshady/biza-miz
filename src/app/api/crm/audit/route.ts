import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCrmAuditEvents } from "@/lib/crm-audit-service";

/**
 * The CRM decision log — «سابقهٔ تصمیم‌ها».
 *
 * Read-only, and there is no POST/PATCH/DELETE on purpose: `crm_audit_events`
 * is append-only evidence, so the only write path in the codebase is
 * `recordCrmAudit` inside the operation that produced the row.
 *
 * Gated on `crm.configure` rather than `crm.view`, which is the manager/admin
 * line: the log names who moved a deal, who converted a lead onto an existing
 * customer and who decided an anonymous shopper was a particular person. That
 * is a record *about staff*, and the people it is about are not its audience.
 * `src/lib/crm-permissions.ts` is where that rule lives; this route only
 * restates it as a guard.
 *
 * Filtering happens in SQL against validated values — an unknown `kind` or
 * `entityType` is dropped, never escaped and passed through.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const limit = Number(search.get("limit"));
  const page = await listCrmAuditEvents(session.businessId, {
    kind: search.get("kind") ?? undefined,
    entityType: search.get("entityType") ?? undefined,
    entityId: search.get("entityId") ?? undefined,
    actorUserId: search.get("actor") ?? undefined,
    partyId: search.get("partyId") ?? undefined,
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
    q: search.get("q") ?? undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
  });

  return NextResponse.json(page);
});
