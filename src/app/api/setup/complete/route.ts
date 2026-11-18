import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { markSetupComplete } from "@/lib/settings";
import { computeSetupState, requireManager } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";
import { selectedAppSetupStatuses } from "@/lib/setup-apps-service";
import { serviceTariffAt } from "@/lib/service-activation/pricing-service";

/**
 * The canonical interactive completion transition — the *only* one for a
 * first-run wizard. Stamps `setup.progress.completedAt` and records the
 * `setup.completed` audit event, both inside one transaction and both exactly
 * once (issue #808 §2):
 *
 *   - `markSetupComplete` sets the marker only if it is unset, in a single
 *     statement, so two Finish presses cannot both "complete" the setup;
 *   - the audit insert shares that transaction and runs only for the call that
 *     actually stamped it, so the event cannot be duplicated or outlive a
 *     rolled-back stamp.
 *
 * Readiness is checked first, from persisted domain data (`computeSetupState`),
 * not from the step markers: a business cannot buy its way past Finish by
 * having a stale `steps.menu` from the days when a category was enough.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const state = await computeSetupState(session.businessId);

  // Every *selected* app's essential answers must be saved before the business
  // wizard can finish. This is deliberately separate from
  // `businesses.setup_progress`: an app's later reconfiguration must never
  // reopen the business's onboarding, and an unselected app is never a
  // requirement.
  const selectedAppStatuses = await selectedAppSetupStatuses(
    session.businessId,
    state.selectedApps,
  );
  const incompleteApps = selectedAppStatuses.filter((app) => !app.setupComplete);
  const selectedKeys = state.selectedApps ?? [];
  const tariffs = await Promise.all(
    selectedKeys.map((key) => serviceTariffAt({ kind: "app", key })),
  );
  const unpriced = selectedKeys.filter((_, index) => {
    const tariff = tariffs[index];
    return !tariff || tariff.published === false;
  });

  const messages = [
    ...(state.selectedApps === null ? ["انتخاب برنامه‌ها ذخیره نشده است."] : []),
    ...state.missingForCompletion,
    ...incompleteApps.map((app) => `راه‌اندازی برنامهٔ ${app.label} کامل نشده است.`),
    ...unpriced.map((key) => `تعرفهٔ منتشرشدهٔ برنامهٔ ${key} موجود نیست.`),
  ];
  if (messages.length > 0) {
    return NextResponse.json({ error: "incomplete", messages }, { status: 409 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { progress, stamped } = await markSetupComplete(session.businessId, client);
    if (stamped) {
      await client.query(
        `INSERT INTO audit_log (business_id, user_id, action, entity)
         VALUES ($1, $2, 'setup.completed', 'business')`,
        [session.businessId, session.sub],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      completedAt: progress.completedAt,
      alreadyComplete: !stamped,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});
