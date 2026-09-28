import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { effectiveFeatures } from "@/lib/features";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { resolveAccessibleAppLanding } from "@/lib/apps";
import { accessibleNavItemsFor } from "@/app/dashboard/workspace-shell";

/**
 * Permission-aware Accounting app door.
 *
 * The shell's canonical, member-filtered navigation decides both whether this
 * member has an Accounting section and which one is the best landing. This is
 * deliberately server-side: typing `/accounting` cannot bypass a hidden link,
 * and a cashier is not bounced through the ledger-only overview.
 */
export default async function AccountingIndexPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const member = await memberAccessFor(session);
  if (!member?.isActive) redirect("/login");

  const industry = (await getBusinessIndustry(session.businessId)) ?? "food_service";
  const features = await effectiveFeatures(session.businessId);
  const navigation = accessibleNavItemsFor(
    industry,
    { settingsTabs: [] },
    member.role,
    member.permissions,
    features,
  );
  const landing = resolveAccessibleAppLanding("accounting", navigation);
  if (!landing) redirect("/dashboard");
  redirect(landing);
}
