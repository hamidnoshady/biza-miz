import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { PIN_ROLES } from "@/lib/roles";
import { requireRecentAuth } from "@/lib/recent-auth";
import { EmployeeError, revokeCredential } from "@/lib/employee-service";

/** Revokes one of the caller's own registered authenticators — never another employee's, see revokeCredential's ownerEmployeeId. */
export const DELETE = withTenantScope(
  async (_request, context: { params: Promise<{ credentialId: string }> }) => {
    const { session, error } = await requireRole(...PIN_ROLES);
    if (error) return error;

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
