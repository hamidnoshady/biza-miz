import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { describeCredentialSurface } from "@/lib/credential-authority";
import { readSelfCredentialState } from "@/lib/self-credentials";
import { isPasswordRole } from "@/lib/roles";
import { accessibleLocationsFor, businessLocations, resolveActiveLocation } from "@/lib/setup-state";
import { listWebauthnCredentials } from "@/lib/employee-service";
import { webauthnManagementPolicy } from "@/lib/webauthn-policy";
import { describeProfileBranches, type ProfileBranchInfo } from "@/lib/profile-branch";
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
 *
 * #854 follow-up:
 *  - **F13** — the branch shown is the session's *active* branch as the server
 *    resolves it for this membership (re-read from `users`/`user_locations`
 *    under the tenant scope, so a revoked assignment falls back exactly as the
 *    rest of the app does), and the home branch's relation to it is stated
 *    explicitly — the same branch, a different one, none assigned, or one
 *    that is no longer active. Nothing about the branch comes from the client.
 *  - **F02** — the biometric card is rendered from `webauthn-policy.ts`, the
 *    same function the registration routes enforce: offered to the roles that
 *    may enrol, and kept for anyone who already holds an authenticator.
 */
export default async function ProfilePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const tenantScope = { locationId: session.locationId, userId: session.sub };
  const { rows } = await withTenant(
    session.businessId,
    () =>
      query<{
        full_name: string;
        email: string | null;
        phone_e164: string | null;
        role: Role;
        is_active: boolean;
        location_id: string | null;
      }>(
        "SELECT full_name, email, phone_e164, role, is_active, location_id FROM users WHERE id = $1 AND business_id = $2",
        [session.sub, session.businessId],
      ),
    tenantScope,
  );
  const member = rows[0];
  if (!member?.is_active) redirect("/login");

  const [credentials, deployment, branch, webauthnCount] = await Promise.all([
    readSelfCredentialState(session.businessId, session.sub),
    readDeploymentProfile(session.businessId),
    withTenant(session.businessId, () => resolveProfileBranches(session, member.location_id), tenantScope),
    withTenant(
      session.businessId,
      async () => (await listWebauthnCredentials(session.sub, session.businessId)).length,
      tenantScope,
    ),
  ]);
  const webauthnSurface = describeCredentialSurface(deployment.profile, "webauthn_credential");
  const webauthnPolicy = webauthnManagementPolicy({ role: member.role, surface: webauthnSurface });

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
        branch={branch}
        showBiometric={webauthnPolicy.canRegister || webauthnCount > 0}
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
          webauthn_credential: webauthnSurface,
        }}
      />
    </PageShell>
  );
}

/**
 * Active vs home branch for the Profile header (#854 follow-up F13).
 *
 * `resolveActiveLocation` honours the session's active branch only while the
 * member can still reach it (otherwise their default accessible branch), the
 * same resolution every branch-scoped route uses. The home branch is the
 * membership's own `location_id`, with its relation to the active branch
 * stated explicitly (`homeStatus`: same / different / unassigned /
 * unavailable), so the two are never conflated and a missing or deactivated
 * home branch is never presented as "this one".
 */
async function resolveProfileBranches(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  homeLocationId: string | null,
): Promise<ProfileBranchInfo> {
  const [active, access, locations] = await Promise.all([
    resolveActiveLocation(session),
    accessibleLocationsFor(session),
    businessLocations(session.businessId),
  ]);
  return describeProfileBranches({
    active,
    homeLocationId,
    businessLocations: locations,
    access,
  });
}
