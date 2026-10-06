import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { resolveDeviceId } from "@/lib/device-service";
import { requestHost } from "@/lib/host";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { loginRoster, resolveLoginBusinessId } from "@/lib/employee-service";
import { readHybridIdentityStatus } from "@/lib/iam/login-credential-sync";
import { phoneOtpEnforcementFor } from "@/lib/phone-otp";

/**
 * Phase 20 Wave 2 — the name-then-PIN login redesign's first step: who is
 * signing in. Deliberately public (there is no session yet, by definition),
 * and deliberately thin: only name, role, and photo, the same fields a
 * badge on a POS terminal would show, never a PIN or anything from
 * `employees` beyond its photo.
 *
 * Wave 4 — an optional `deviceToken` (this terminal's paired-device token,
 * if any, carried client-side — see src/app/login/page.tsx) narrows
 * `hasWebauthn` to credentials actually registered on this terminal; an
 * unresolvable or absent token behaves exactly as before pairing existed.
 *
 * Phase 42 — the response also carries the business's phone-OTP policy
 * (`policy.state`, `policy.daysLeft`, `policy.enforcedAt`), once per load:
 * the door needs it to know whether to offer the «ورود با شمارهٔ موبایل»
 * tab and the adoption-window banner, and each roster entry already carries
 * its own per-member `loginMode` (computed here, server-side) so the client
 * never re-derives a security decision from name-level data.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const { businessId, error } = await resolveLoginBusinessId({
    businessId: params.get("businessId") ?? undefined,
    businessSlug: params.get("businessSlug") ?? undefined,
    locationId: params.get("locationId") ?? undefined,
    host: requestHost(request.headers),
  });
  if (!businessId) {
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    const deviceId = await resolveDeviceId(params.get("deviceToken"), businessId);
    const [employees, enforcement, deployment] = await Promise.all([
      loginRoster(businessId, params.get("locationId"), deviceId),
      phoneOtpEnforcementFor(businessId),
      readDeploymentProfile(businessId),
    ]);
    // Hybrid only: the roster above silently omits a member whose replicated
    // PIN has not arrived (loginRoster lists only members a PIN can sign in),
    // which reads to the operator as "this business has one employee". Report
    // the credential plane next to the roster so the login screen can say the
    // list is incomplete, offer a retry and link to the connection panel —
    // counts and names only, never a credential.
    const health = deployment.profile === "hybrid"
      ? await readHybridIdentityStatus(businessId)
      : null;
    return NextResponse.json({
      employees,
      policy: {
        state: enforcement.state,
        daysLeft: enforcement.daysLeft,
        enforcedAt: enforcement.policy.enforcedAt,
      },
      credentialSync: health?.configured
        ? {
            state: health.credentials?.status ?? "pending",
            overall: health.overall,
            expected: health.pinGap.expected,
            usable: health.pinGap.usable,
            missing: health.pinGap.missing,
            missingMembers: health.pinGap.missingMembers.map((member) => ({
              id: member.id,
              fullName: member.fullName,
              role: member.role,
            })),
            lastSuccessAt: health.credentials?.lastSuccessAt ?? null,
            lastError: health.credentials?.lastError ?? null,
          }
        : null,
    });
  });
}
