import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
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

  return (
    <PageShell className="max-w-[1100px]">
      <PageHeader
        title="حساب کاربری"
        description="نام، نقش، رمز عبور، ورود دومرحله‌ای و نشست‌های فعال شما در این کسب‌وکار. تنظیمات کسب‌وکار جای دیگری است."
      />
      <ProfileSection
        fullName={member.full_name ?? session.fullName}
        phone={member.phone_e164}
        email={member.email ?? null}
        role={member.role}
        isOwner={member.role === "owner"}
        canUseMfa={["owner", "manager"].includes(member.role)}
      />
    </PageShell>
  );
}
