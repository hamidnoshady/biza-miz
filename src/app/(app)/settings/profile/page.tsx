import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { describeCredentialSurface } from "@/lib/credential-authority";
import { readSelfCredentialState } from "@/lib/self-credentials";
import { isPasswordRole } from "@/lib/roles";
import { ProfileSection } from "./profile-section";

export const metadata = { title: "حساب کاربری" };

/**
 * `/settings/profile` — the signed-in member's own account.
 *
 * A platform page, and the only settings URL every role can open: the tabs of
 * the settings manager are all owner/manager configuration of the *business*,
 * so a cashier who tapped «تنظیمات پلتفرم» used to be bounced straight back to
 * the dashboard. Their own name, role, branch and second factor are theirs to
 * see, and they are not business configuration, so they live here rather than
 * as a seventeenth tab nobody but an owner could reach.
 *
 * Issue #854 (P1.2 / P1.14 / P1.15) — what the screen is *allowed* to offer is
 * now a server decision:
 *
 *  - `canUseMfa` comes from whether this membership has a global login at all,
 *    instead of a hard-coded `["owner","manager"]` list that hid the 2FA card
 *    from an `admin` (for whom it is mandatory) and from an `accountant`;
 *  - each cloud-owned credential card receives the deployment's authority over
 *    it, so a Hybrid site renders the control read-only with the reason rather
 *    than letting the member fill in a form the backend will refuse.
 */
export default async function ProfilePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const { rows } = await withTenant(
    session.businessId,
    () =>
      query<{ full_name: string; email: string | null; phone_e164: string | null; role: Role; is_active: boolean }>(
        "SELECT full_name, email, phone_e164, role, is_active FROM users WHERE id = $1 AND business_id = $2",
        [session.sub, session.businessId],
      ),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];
  if (!member?.is_active) redirect("/login");

  const [credentials, deployment] = await Promise.all([
    readSelfCredentialState(session.businessId, session.sub),
    readDeploymentProfile(session.businessId),
  ]);

  return (
    <PageShell className="max-w-[1100px]">
      <PageHeader
        title="حساب کاربری"
        description="نام، نقش، رمز عبور یا رمز عددی، ورود دومرحله‌ای، شمارهٔ ورود و نشست‌های فعال شما در این کسب‌وکار. تنظیمات کسب‌وکار جای دیگری است."
      />
      <ProfileSection
        fullName={member.full_name ?? session.fullName}
        phone={member.phone_e164}
        email={member.email ?? null}
        role={member.role}
        isOwner={member.role === "owner"}
        /**
         * Authoritative first: does this membership actually have a global
         * login? The role test is only the fallback for the (impossible) case
         * of the credential read returning nothing.
         */
        canUseMfa={credentials?.hasGlobalIdentity ?? isPasswordRole(member.role)}
        credentialSurfaces={{
          global_password: describeCredentialSurface(deployment.profile, "global_password"),
          login_phone: describeCredentialSurface(deployment.profile, "login_phone"),
          totp_secret: describeCredentialSurface(deployment.profile, "totp_secret"),
          staff_pin: describeCredentialSurface(deployment.profile, "staff_pin"),
          /**
           * Issue #854 (P2.28) — the profile page is now the canonical home of
           * WebAuthn/biometric credential management; its authority rides the
           * same deployment matrix as every other credential surface.
           */
          webauthn_credential: describeCredentialSurface(deployment.profile, "webauthn_credential"),
        }}
      />
    </PageShell>
  );
}
