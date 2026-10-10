import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission, requireRole } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getMfaPolicy, setMfaPolicy } from "@/lib/mfa-policy";

/**
 * Phase 24 Wave 2 — the per-business two-factor policy.
 *
 * Issue #854 (P1.1): two knobs, and two non-knobs.
 *
 *  - `owner` and `admin` are **mandatory** and deliberately not exposed here.
 *    The requirement on the full permission set is the point of the policy, not
 *    a preference — and before this pass `admin` was not covered at all.
 *  - `manager` — the documented opt-in, off by default.
 *  - `accountant` — configurable and risk-based, off by default, fully
 *    supported when on.
 *
 * The **write** is guarded on the `owner` role rather than the `settings.manage`
 * permission that gates the read of the rest of this directory. A manager
 * holding `settings.manage` — the default on most businesses — could otherwise
 * switch off the requirement that applies to managers, which is to say vote on
 * whether they themselves need a second factor. The read stays on
 * `settings.manage` so the settings screen can render the current state.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  return NextResponse.json({ policy: await getMfaPolicy(session.businessId) });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { requireForManagers?: unknown; requireForAccountants?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const requireForManagers = body.requireForManagers === true;
  /**
   * Issue #854 (P1.1): `accountant` is a password role that reaches the ledger
   * and is now a policy knob ("configurable / risk-based, but supported
   * fully"). `owner` and `admin` are deliberately absent — they are mandatory
   * by construction and not a per-business setting.
   */
  const requireForAccountants = body.requireForAccountants === true;
  const policy = await setMfaPolicy(session.businessId, {
    requireForManagers,
    requireForAccountants,
  });

  // Turning this on can lock a manager out at their next login once their own
  // grace window expires, and turning it off weakens the business's posture.
  // Either direction is worth a row in the trail.
  await query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'settings.mfa_policy.update', 'settings', 'mfa.policy', $4)`,
    [
      session.businessId,
      session.locationId,
      session.sub,
      JSON.stringify({ requireForManagers, requireForAccountants }),
    ],
  );

  return NextResponse.json({ policy });
});
