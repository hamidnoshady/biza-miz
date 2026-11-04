import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

export default async function Page() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "marketing-targets")) redirect(growthFallbackHref(permissions));
  return <GrowthSection section="marketing-targets" permissions={[...permissions]} />;
}
