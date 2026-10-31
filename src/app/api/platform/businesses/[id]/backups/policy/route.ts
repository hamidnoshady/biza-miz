import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { resolveTenantBackupPolicy } from "@/lib/tenant-backup-storage";
import {
  clearBusinessPolicyOverride,
  validatePolicyOverrideBody,
  writeBusinessPolicyOverride,
} from "@/lib/tenant-backup-approvals";

/**
 * Issue #903 §3 — approved **business-specific policy overrides**.
 *
 * The fleet row decides what every business inherits; this route decides what
 * *this* business gets instead. Three rules keep it from becoming a second,
 * unbounded policy system:
 *
 *  1. **Bounded by the fleet.** `GET` returns both the effective policy and the
 *     fleet row, so the console can show the envelope an override lives in. The
 *     resolver clamps retention and the keep count to the fleet's own ceilings,
 *     so a value that breaches them tightens instead of escaping.
 *  2. **Clearable.** `DELETE` removes the row, which is how a business returns to
 *     the fleet policy. An override is an exception, not a permanent state.
 *  3. **Audited with the reason.** `note` is required to be meaningful by the
 *     console, and every write records before/after values — the epic asks for
 *     approved overrides, and "approved" is only meaningful with a record.
 *
 * Capability `tenant_backup.policy` (owner-level): it changes what the scheduler
 * does for one tenant.
 */
export const GET = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { error } = await requirePlatformCapability("tenant_backup.policy");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const [effective, fleet] = await Promise.all([
      resolveTenantBackupPolicy(id),
      resolveTenantBackupPolicy(),
    ]);
    return NextResponse.json(
      { policy: effective, fleet },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);

export const PUT = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.policy");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const validated = validatePolicyOverrideBody(body);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

    const before = await resolveTenantBackupPolicy(id);
    await writeBusinessPolicyOverride(id, { ...validated.value, updatedBy: session.padmin });
    const after = await resolveTenantBackupPolicy(id);

    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "tenant_backup.policy.override",
      entity: "tenant_backup_business_policy",
      payload: {
        // The *effective* numbers, not the request: clamping is part of the
        // decision, and an audit that recorded what was asked would hide it.
        before: {
          intervalHours: before.intervalHours,
          retentionDays: before.retentionDays,
          keepCount: before.keepCount,
          protectedCopies: before.protectedCopies,
          requireRestoreApproval: before.requireRestoreApproval,
        },
        after: {
          intervalHours: after.intervalHours,
          retentionDays: after.retentionDays,
          keepCount: after.keepCount,
          protectedCopies: after.protectedCopies,
          requireRestoreApproval: after.requireRestoreApproval,
        },
        fields: Object.keys(validated.value),
      },
    }).catch(() => undefined);

    return NextResponse.json(
      { ok: true, policy: after, fleet: await resolveTenantBackupPolicy() },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);

export const DELETE = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.policy");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    await clearBusinessPolicyOverride(id);
    const policy = await resolveTenantBackupPolicy(id);
    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "tenant_backup.policy.clear",
      entity: "tenant_backup_business_policy",
      payload: { intervalHours: policy.intervalHours, retentionDays: policy.retentionDays },
    }).catch(() => undefined);

    return NextResponse.json(
      { ok: true, policy, fleet: await resolveTenantBackupPolicy() },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
