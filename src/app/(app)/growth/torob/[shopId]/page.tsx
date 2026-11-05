import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { growthAbilities } from "@/lib/growth-access";
import { canViewGrowthSection, growthFallbackHref } from "../../growth-routes";
import { TorobShopDetail } from "../../torob-shop-detail";

/**
 * `/growth/torob/[shopId]` — one shop's channel (issue #894, Wave 4).
 *
 * Still inside Growth and still under its own section gate: the page's read is the
 * section's key (`torob.view`), and the writing it offers is gated by
 * `torob.configure` in the same abilities record the section uses. A member who
 * may look but not configure sees the grid without the buttons — never a button
 * whose request the server would refuse (growth-access.test.ts asserts the two
 * halves agree).
 *
 * The shop id is not resolved here: the API answers 404 for a shop that is not this
 * business's, so a hand-typed id is a message on the page rather than a leak of
 * whether the shop exists.
 */
export default async function GrowthTorobShopPage({ params }: { params: Promise<{ shopId: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "torob")) redirect(growthFallbackHref(permissions));

  const { shopId } = await params;
  const abilities = growthAbilities(permissions);
  return <TorobShopDetail shopId={shopId} canConfigure={abilities.configureTorob} />;
}
