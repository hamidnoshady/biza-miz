import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { listWebauthnCredentials } from "@/lib/employee-service";
import { resolveWebauthnPolicy } from "@/lib/webauthn-access";

/**
 * The caller's own registered authenticators, for the Profile card.
 *
 * Issue #854 follow-up (F02 / F12): any member may *list* their own
 * authenticators — `webauthn-policy.ts` keeps listing apart from registering.
 * This used to be `requireRole(...PIN_ROLES)`, so a member whose role had moved
 * off the till could no longer see an authenticator still registered to their
 * membership, and so could not revoke it. The rows are still the caller's only
 * (`session.sub`), and the response says what the caller may do with them, so
 * the card renders the server's answer instead of guessing from the role.
 */
export const GET = withTenantScope(async () => {
  const { session, membership, error } = await requireMember();
  if (error) return error;

  const [credentials, { policy }] = await Promise.all([
    listWebauthnCredentials(session.sub, session.businessId),
    resolveWebauthnPolicy(session.businessId, membership.role),
  ]);
  return NextResponse.json({
    credentials,
    canRegister: policy.canRegister,
    canRemove: policy.canRemove,
    registerBlockedBy: policy.registerBlockedBy,
  });
});
