import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { query, withoutTenantScope } from "@/lib/db";
import { resolveTenantBackupPolicy } from "@/lib/tenant-backup-storage";
import {
  clearBackupPlanPolicy,
  listBackupPlanPolicies,
  validatePlanPolicyBody,
  writeBackupPlanPolicy,
} from "@/lib/tenant-backup-plan-policy";

/**
 * Issue #903 §3 — **the per-plan half of the backup policy**.
 *
 * `GET` answers every plan in the catalogue together with the policy it currently
 * has (or none), plus the fleet row it inherits from — the envelope a plan lives
 * inside, so the console can show what "tighter" means for each field.
 *
 * `PUT` writes one plan's policy from the body's `planKey`. Three rules, the same
 * ones the per-business override keeps:
 *
 *  1. **Bounded by the fleet.** The resolver clamps every field (a plan can only
 *     tighten), and the audit records the *effective* numbers, not the request.
 *  2. **Clearable.** `DELETE ?planKey=…` removes the row; every business on that
 *     plan returns to the fleet defaults.
 *  3. **Audited.** A plan policy changes what the scheduler does for every
 *     business sold on it, so the write is recorded with before/after.
 *
 * Capability `tenant_backup.policy` (owner-level), exactly like enabling managed
 * cloud. Nothing here is tenant-reachable, and the response never names a
 * business: a plan is a catalogue row.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("tenant_backup.read");
  if (error) return error;

  const [policies, fleet, plans] = await Promise.all([
    listBackupPlanPolicies(),
    resolveTenantBackupPolicy(),
    withoutTenantScope("tenant-backup-plan-policy", async () => {
      const { rows } = await query<{ key: string; name: string }>(
        `SELECT key, name FROM billing_plans ORDER BY sort_order, key`,
        [],
      );
      return rows;
    }).catch(() => [] as { key: string; name: string }[]),
  ]);

  return NextResponse.json(
    {
      fleet,
      // Every plan in the catalogue, with its policy when it has one. A plan with
      // no row is listed too: "this plan inherits everything" is an answer an
      // operator needs, and leaving it out would make the set look complete when
      // the important question is which plans were never decided.
      plans: plans.map((plan) => ({
        planKey: plan.key,
        name: plan.name,
        policy: policies[plan.key] ?? null,
      })),
      // A policy row whose plan has since been deleted cannot exist (the FK is
      // ON DELETE CASCADE), so this is only ever the catalogue's own set.
      policies,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("tenant_backup.policy");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const planKey = typeof body.planKey === "string" ? body.planKey.trim() : "";
  if (!planKey || planKey.length > 64) return NextResponse.json({ error: "invalid_plan" }, { status: 400 });

  const { planKey: _ignored, ...fields } = body;
  const validated = validatePlanPolicyBody(fields);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  // The plan must exist: writing a policy for a typo would create a row that no
  // business can ever inherit, and the operator would believe a tier was shaped.
  const exists = await withoutTenantScope("tenant-backup-plan-policy", async () => {
    const { rows } = await query<{ key: string }>(`SELECT key FROM billing_plans WHERE key = $1`, [planKey]);
    return rows.length > 0;
  }).catch(() => false);
  if (!exists) return NextResponse.json({ error: "unknown_plan" }, { status: 404 });

  await writeBackupPlanPolicy(planKey, { ...validated.value, updatedBy: session.padmin });

  await platformAudit({
    adminId: session.padmin,
    action: "tenant_backup.plan_policy.update",
    entity: "tenant_backup_plan_policy",
    payload: {
      planKey,
      // The request, not a resolved policy: a plan is layered per business, so
      // there is no single "after" to record — the clamping is what each
      // business's resolver does, and this records what was asked for.
      fields: validated.value,
      keys: Object.keys(validated.value),
    },
  }).catch(() => undefined);

  const [fleet, policy] = await Promise.all([
    resolveTenantBackupPolicy(),
    listBackupPlanPolicies().then((all) => all[planKey] ?? null),
  ]);
  return NextResponse.json({ ok: true, planKey, policy, fleet }, { headers: { "Cache-Control": "no-store" } });
});

export const DELETE = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("tenant_backup.policy");
  if (error) return error;

  const planKey = (request.nextUrl.searchParams.get("planKey") ?? "").trim();
  if (!planKey) return NextResponse.json({ error: "invalid_plan" }, { status: 400 });

  await clearBackupPlanPolicy(planKey);

  await platformAudit({
    adminId: session.padmin,
    action: "tenant_backup.plan_policy.clear",
    entity: "tenant_backup_plan_policy",
    payload: { planKey },
  }).catch(() => undefined);

  return NextResponse.json(
    { ok: true, planKey, fleet: await resolveTenantBackupPolicy() },
    { headers: { "Cache-Control": "no-store" } },
  );
});
