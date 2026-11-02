import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/**
 * `/growth/torob` — the Torob channel, inside Growth (issue #894).
 *
 * A section of the app and not a separate product, which is the issue's own
 * boundary: the merchant manages one channel from the Growth menu, never a second
 * wizard or a second product editor. The gate is the section's own key
 * (`torob.view`), so whoever can open this page can also read what it loads.
 *
 * A per-shop page (`/growth/torob/[shopId]`) arrives with Wave 2, when there is
 * something to put on it: the feed, what Torob accepted, and what it indexed. In
 * this wave every fact a shop has fits on its row, and a detail route that only
 * repeated that row would be a dead end dressed as a page.
 */
export default async function GrowthTorobPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "torob")) redirect(growthFallbackHref(permissions));

  return <GrowthSection section="torob" permissions={[...permissions]} />;
}
