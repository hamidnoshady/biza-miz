import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { requireRecentAuth } from "@/lib/recent-auth";
import { beginWebauthnRegistration } from "@/lib/employee-service";
import { resolveWebauthnPolicy, webauthnPolicyDenial } from "@/lib/webauthn-access";

/**
 * Phase 20 Wave 3 — step 1 of registering a biometric authenticator: always
 * self-service (the caller registers their own device, never someone
 * else's), and restricted to the same PIN-role audience as the lock screen
 * and the login picker (Wave 2) — biometric is an alternative to *PIN*
 * entry, not to a password login.
 *
 * Issue #854 follow-up (F02): that audience is now `webauthn-policy.ts`'s
 * answer, evaluated against the membership's *current* database role — the
 * same function the Profile card renders from, so the card cannot offer a
 * ceremony this route refuses.
 */
export const POST = withTenantScope(async () => {
  const { session, membership, error } = await requireMember();
  if (error) return error;

  const denial = webauthnPolicyDenial(
    await resolveWebauthnPolicy(session.businessId, membership.role),
    "register",
  );
  if (denial) return denial;

  /**
   * Issue #854 (P1.8): registering an authenticator *is* adding a credential to
   * the account, so it is a sensitive mutation and needs the same
   * recent-authentication bar as changing a password or a second factor. It
   * previously needed only a session cookie, so an unlocked till could be given
   * a new biometric key by whoever was standing at it.
   */
  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;

  const { options, challengeToken } = await beginWebauthnRegistration(
    session.sub,
    session.businessId,
    session.fullName,
  );
  return NextResponse.json({ options, challengeToken });
});
