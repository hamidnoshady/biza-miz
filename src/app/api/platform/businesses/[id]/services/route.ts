import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import {
  holdServiceActivation,
  listBusinessServiceActivations,
  releaseServiceActivation,
  settleServiceRuntime,
} from "@/lib/service-activation/activation-service";
import {
  cancelServicePurge,
  clearBusinessRetentionOverride,
  listBusinessRetentionOverrides,
  listServicePurgeJournal,
  listServicePurgeQueue,
  retryServicePurge,
  runDueServicePurges,
  saveBusinessRetentionOverride,
} from "@/lib/service-activation/retention-service";
import {
  isServiceKey,
  isServiceKind,
  type ServiceIdentity,
} from "@/lib/service-activation/catalog";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One business's service activations, as the console's business page shows them
 * (issue #1041 §E.4): state, setup-paid evidence, settlement history, the
 * retention deadline, per-business overrides, the queue and the journal.
 */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("billing.view");
  if (error) return error;
  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [activations, overrides, queue, journal] = await Promise.all([
    listBusinessServiceActivations(id),
    listBusinessRetentionOverrides(id),
    listServicePurgeQueue(id),
    listServicePurgeJournal(id),
  ]);
  return NextResponse.json({ activations, overrides, queue, journal });
});

/**
 * Console actions for one business's services:
 *
 *   retention-override        pin a per-business window (owner only)
 *   clear-retention-override  return to the platform policy (owner only)
 *   hold / release            legal or operational hold (owner only)
 *   retry-purge / cancel-purge / dry-run  the destruction queue (owner only)
 *   settle                    catch up an activation's due runtime (billing.manage)
 *
 * Every write is audited. None of them bypasses the worker's own re-checks:
 * a hold blocks a purge, and a re-enable still wins over a queued purge.
 */
export const PATCH = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const { id: businessId } = await ctx.params;
  const business = await getBusiness(businessId);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const destructive = [
    "retention-override",
    "clear-retention-override",
    "hold",
    "release",
    "retry-purge",
    "cancel-purge",
    "dry-run",
  ];
  const capability = destructive.includes(action) ? "retention.manage" : "billing.manage";
  const { session, error } = await requirePlatformCapability(capability);
  if (error) return error;

  const kind = body.kind;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const hasIdentity = isServiceKind(kind) && isServiceKey(kind, key);
  const identity: ServiceIdentity | null = hasIdentity
    ? {
        kind: kind as ServiceIdentity["kind"],
        key,
        runtimeInstanceId:
          typeof body.runtimeInstanceId === "string" ? body.runtimeInstanceId.trim() : "",
      }
    : null;

  const audit = async (detail: Record<string, unknown>) =>
    platformAudit({
      adminId: session.padmin,
      businessId,
      action: `service.${action}`,
      entity: "business_service_activation",
      entityId: identity ? `${identity.kind}:${identity.key}` : null,
      payload: detail,
    });

  if (action === "retention-override") {
    if (!identity) return NextResponse.json({ error: "unknown_service" }, { status: 404 });
    const policy = await saveBusinessRetentionOverride({
      businessId,
      kind: identity.kind,
      key: identity.key,
      autoPurgeEnabled: body.autoPurgeEnabled === true,
      retentionDays:
        body.retentionDays === null || body.retentionDays === undefined
          ? null
          : Number(body.retentionDays),
      adminId: session.padmin,
      note: typeof body.note === "string" ? body.note : null,
    });
    await audit({ kind: identity.kind, key: identity.key, policy });
    return NextResponse.json({ policy });
  }

  if (action === "clear-retention-override") {
    if (!identity) return NextResponse.json({ error: "unknown_service" }, { status: 404 });
    await clearBusinessRetentionOverride(businessId, identity.kind, identity.key);
    await audit({ kind: identity.kind, key: identity.key, cleared: true });
    return NextResponse.json({ ok: true });
  }

  if (action === "hold" || action === "release") {
    if (!identity) return NextResponse.json({ error: "unknown_service" }, { status: 404 });
    const activation =
      action === "hold"
        ? await holdServiceActivation({
            businessId,
            identity,
            platformAdminId: session.padmin,
            note: typeof body.note === "string" ? body.note : null,
          })
        : await releaseServiceActivation({ businessId, identity, platformAdminId: session.padmin });
    await audit({ kind: identity.kind, key: identity.key, state: activation.state });
    return NextResponse.json({ activation });
  }

  if (action === "retry-purge" || action === "cancel-purge") {
    const activationId = typeof body.activationId === "string" ? body.activationId : "";
    if (!activationId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    if (action === "retry-purge") {
      const queueRow = await retryServicePurge(businessId, activationId);
      await audit({ activationId, queue: queueRow });
      return NextResponse.json({ queue: queueRow });
    }
    await cancelServicePurge(businessId, activationId);
    await audit({ activationId, cancelled: true });
    return NextResponse.json({ ok: true });
  }

  if (action === "dry-run") {
    const result = await runDueServicePurges({ dryRun: true, limit: 50 });
    await audit({ dryRun: true, result });
    return NextResponse.json({ result });
  }

  if (action === "settle") {
    if (!identity) return NextResponse.json({ error: "unknown_service" }, { status: 404 });
    const settlement = await settleServiceRuntime({ businessId, identity });
    await audit({ kind: identity.kind, key: identity.key, settlement });
    return NextResponse.json({ settlement });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
