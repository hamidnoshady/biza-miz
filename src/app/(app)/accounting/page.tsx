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
 * The shell's canonical, member-filtered navigation decides whether this
 * member has any Accounting section at all; the app's home
 * (`/accounting/overview`, `AppDef.sharedHome`) is where every admitted member
 * lands, and the page itself shows only what their effective permissions allow
 * (the ledger dashboard for `ledger.view`, an operational page of shortcuts
 * otherwise). This is deliberately server-side: typing `/accounting` cannot
 * bypass a hidden link, and a cashier is neither bounced through the ledger
 * dashboard nor forced into the till (issue #1124).
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
