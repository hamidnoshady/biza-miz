import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  GrantMutationError,
  extendComplimentaryGrant,
  listBusinessComplimentaryGrants,
  revokeComplimentaryGrant,
} from "@/lib/complimentary-grant-service";

/**
 * Per-business complimentary grant administration (GitHub #1579).
 *
 * This is deliberately NOT a second per-business billing console: the
 * business's existing Billing page links here for the grant-specific actions
 * (list, extend, revoke) that the ordinary tariffs and plan controls cannot
 * express. Every mutation is audited with the actor's reason.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("billing.view");
  if (error) return error;
  const businessId = request.nextUrl.searchParams.get("businessId") ?? "";
  if (!businessId) {
    return NextResponse.json({ error: "business_required" }, { status: 400 });
  }
  return NextResponse.json({
    grants: await listBusinessComplimentaryGrants(businessId),
  });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("billing.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const businessId = typeof body.businessId === "string" ? body.businessId : "";
  const grantId = typeof body.grantId === "string" ? body.grantId : "";
  const action = body.action;
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!businessId || !grantId || (action !== "extend" && action !== "revoke")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (action === "extend") {
      const expiresAt =
        body.expiresAt === null ? null : typeof body.expiresAt === "string" ? body.expiresAt : "";
      if (expiresAt === "") {
        return NextResponse.json({ error: "invalid_expiry" }, { status: 400 });
      }
      const grant = await extendComplimentaryGrant({
        businessId,
        grantId,
        expiresAt,
        actor: session.padmin,
        reason,
      });
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: "complimentary_grant.extend",
        entity: "business_complimentary_grant",
        entityId: grantId,
        payload: { expiresAt: grant.expiresAt, reason },
      });
      return NextResponse.json({ grant });
    }

    const grant = await revokeComplimentaryGrant({
      businessId,
      grantId,
      actor: session.padmin,
      reason,
    });
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "complimentary_grant.revoke",
      entity: "business_complimentary_grant",
      entityId: grantId,
      payload: { revokedAt: grant.revokedAt, reason },
    });
    return NextResponse.json({ grant });
  } catch (err) {
    if (err instanceof GrantMutationError) {
      return NextResponse.json({ error: err.code }, { status: 409 });
    }
    throw err;
  }
});
