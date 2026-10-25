import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  RetentionPolicyWriteError,
  listRetentionPolicies,
  saveRetentionPolicy,
} from "@/lib/service-activation/retention-service";
import { isServiceKey, isServiceKind } from "@/lib/service-activation/catalog";

/**
 * Superadmin «نگهداری و نابودی خودکار داده» policy, one row per service
 * (issue #1041 §D and §E.3).
 *
 * Reading rides `billing.view`; writing rides the owner-only
 * `retention.manage`, because this switch decides when a customer's operational
 * data is destroyed. Every write is audited with the full before/after policy
 * and the operator who made it.
 *
 * `autoPurgeEnabled: false` (with `retentionDays: null`) is the explicit
 * "keep forever" choice and the default: a service with no row never purges.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("billing.view");
  if (error) return error;
  return NextResponse.json({ policies: await listRetentionPolicies() });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("retention.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!isServiceKind(kind) || !isServiceKey(kind, key)) {
    return NextResponse.json({ error: "unknown_service" }, { status: 404 });
  }

  const before = (await listRetentionPolicies()).find(
    (row) => row.kind === kind && row.key === key,
  );

  try {
    const policy = await saveRetentionPolicy({
      kind,
      key,
      autoPurgeEnabled: body.autoPurgeEnabled === true,
      retentionDays:
        body.retentionDays === null || body.retentionDays === undefined
          ? null
          : Number(body.retentionDays),
      notificationLeadDays:
        body.notificationLeadDays === undefined ? undefined : Number(body.notificationLeadDays),
      exportGraceDays:
        body.exportGraceDays === undefined ? undefined : Number(body.exportGraceDays),
      note: typeof body.note === "string" ? body.note : null,
      adminId: session.padmin,
    });

    await platformAudit({
      adminId: session.padmin,
      action: "service.retention.publish",
      entity: "service_retention_policy",
      entityId: `${kind}:${key}`,
      payload: { before: before ?? null, after: policy },
    });

    return NextResponse.json({ policy });
  } catch (err) {
    if (err instanceof RetentionPolicyWriteError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
});
