import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → consent-aware outbound SMS and email campaigns. */
export default async function GrowthMessagingPage({
  searchParams,
}: {
  searchParams: Promise<{ promotion?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "messaging")) redirect(growthFallbackHref(permissions));

  const { promotion } = await searchParams;
  return <GrowthSection section="messaging" permissions={[...permissions]} initialPromotionId={promotion} />;
}
