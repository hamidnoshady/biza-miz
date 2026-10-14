import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { query } from "@/lib/db";

/**
 * The Billing «تاریخچه تغییرات» tab — a filtered view of the ONE platform
 * audit log (platform_audit_log; no second audit store), narrowed to the
 * commercial actions: plan lifecycle and pricing, subscriptions, business
 * plan changes and overrides, usage/messaging/storage rates, credit packages,
 * gateways, manual payments, wallet adjustments and refunds.
 */
// Route files may only export Next.js route handlers — the catalogue of
// auditable billing actions stays module-local.
const BILLING_AUDIT_ACTIONS = [
  "plan.created",
  "plan.updated",
  "plan.activated",
  "plan.retired",
  "plan.deleted",
  "plan.price.changed",
  "plan.limit.changed",
  "plan.capability.changed",
  "plan.ai_allowance.changed",
  "usage_rate.changed",
  "messaging_rate.changed",
  "storage_rate.changed",
  "credit_package.changed",
  "subscription.created",
  "subscription.changed",
  "subscription.cancelled",
  "subscription.renewed",
  "business.plan",
  "business.plan.changed",
  "business.override.created",
  "business.override.removed",
  "gateway.created",
  "gateway.updated",
  "gateway.enabled",
  "gateway.disabled",
  "manual_payment.approved",
  "manual_payment.rejected",
  "wallet.adjusted",
  "refund.created",
  "billing.spend_policy.updated",
] as const;

export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const url = new URL(req.url);
  const actor = url.searchParams.get("actor");
  const action = url.searchParams.get("action");
  const businessId = url.searchParams.get("business");
  const entityType = url.searchParams.get("entity");
  const since = url.searchParams.get("since");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);

  if (action && !BILLING_AUDIT_ACTIONS.includes(action as (typeof BILLING_AUDIT_ACTIONS)[number])) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { rows } = await query<{
    id: string;
    action: string;
    entity: string | null;
    entity_id: string | null;
    business_id: string | null;
    payload: unknown;
    created_at: string;
    admin_name: string | null;
    admin_role: string | null;
    business_name: string | null;
  }>(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.business_id, a.payload, a.created_at,
            adm.full_name AS admin_name, adm.role AS admin_role, b.name AS business_name
       FROM platform_audit_log a
       LEFT JOIN platform_admins adm ON adm.id = a.platform_admin_id
       LEFT JOIN businesses b ON b.id = a.business_id
      WHERE a.action = ANY($1::text[])
        AND ($2::uuid IS NULL OR a.platform_admin_id = $2)
        AND ($3::text IS NULL OR a.action = $3)
        AND ($4::uuid IS NULL OR a.business_id = $4)
        AND ($5::text IS NULL OR a.entity = $5)
        AND ($6::timestamptz IS NULL OR a.created_at >= $6)
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $7`,
    [
      BILLING_AUDIT_ACTIONS,
      actor || null,
      action || null,
      businessId || null,
      entityType || null,
      since || null,
      limit,
    ],
  );

  return NextResponse.json({
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      businessId: r.business_id,
      businessName: r.business_name,
      actorName: r.admin_name,
      actorRole: r.admin_role,
      payload: r.payload,
      createdAt: r.created_at,
    })),
    actions: BILLING_AUDIT_ACTIONS,
  });
});
