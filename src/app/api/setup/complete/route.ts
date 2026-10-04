import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { markSetupComplete } from "@/lib/settings";
import { computeSetupState, requireManager } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

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
  if (state.missingForCompletion.length > 0) {
    return NextResponse.json(
      { error: "incomplete", messages: state.missingForCompletion },
      { status: 409 },
    );
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
