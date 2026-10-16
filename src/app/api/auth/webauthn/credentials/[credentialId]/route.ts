import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { requireRecentAuth } from "@/lib/recent-auth";
import { EmployeeError, revokeCredential } from "@/lib/employee-service";
import { resolveWebauthnPolicy, webauthnPolicyDenial } from "@/lib/webauthn-access";

/**
 * Revokes one of the caller's own registered authenticators — never another
 * employee's, see revokeCredential's ownerEmployeeId.
 *
 * Issue #854 follow-up (F02 / F12): removal is open to every member for their
 * own authenticators (it only ever reduces what can sign in), where it used to
 * be PIN-roles-only — which stranded an authenticator registered before a role
 * change. Recent authentication is still required (#854 P1.8).
 */
export const DELETE = withTenantScope(
  async (_request, context: { params: Promise<{ credentialId: string }> }) => {
    const { session, membership, error } = await requireMember();
    if (error) return error;

    const denial = webauthnPolicyDenial(
      await resolveWebauthnPolicy(session.businessId, membership.role),
      "remove",
    );
    if (denial) return denial;

    /**
     * Issue #854 (P1.8): removing a factor is as sensitive as adding one — and
     * an attacker who cannot register a key will settle for deleting one.
     */
    const recentAuthError = requireRecentAuth(session);
    if (recentAuthError) return recentAuthError;

    const { credentialId } = await context.params;

    try {
      await revokeCredential(credentialId, session.businessId, session.sub, session.sub);
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof EmployeeError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
