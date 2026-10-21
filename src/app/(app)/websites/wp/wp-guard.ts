import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { canEditWpSection, canSyncWpSection, canViewWpSection, type WpSectionCaps, type WpSectionKey } from "./wp-routes";

/**
 * The role line every page of the WordPress manager stands behind — written
 * once, from the same rule the menu is filtered by.
 *
 * All nine pages of this manager opened with the identical four lines: fetch
 * the session, bounce to `/login` without one, then a hand-inlined
 * `role !== "owner" && role !== "manager"` bounce to `/dashboard`. Nine copies
 * of a rule that already existed as a function — `canViewWpSection`, which was
 * exported, documented as "the role gate", and called by nothing. So the menu
 * and the pages agreed only by coincidence: widening the gate in the one place
 * that looked like the source of truth would have opened the menu entries
 * while every page behind them still redirected away.
 *
 * The guard stays on the pages rather than being left to `layout.tsx` alone.
 * A layout guard is real, but Next renders layouts and pages in parallel and a
 * page is its own entry point, so each one re-checking is the defence in depth
 * the rest of this codebase keeps — one *rule*, checked in every place, rather
 * than one place trusted by eight others.
 *
 * Returns the session, so a caller that needs the business id or the role does
 * not fetch it twice.
 */
export async function requireWpSection(key: WpSectionKey) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  if (!canViewWpSection(access?.permissions ?? new Set(), key)) redirect("/dashboard");
  return session;
}

/**
 * The write-side half of the matrix, for the layout to hand down to the
 * client sections (via the store context) so an action the member may not
 * take renders disabled with a reason instead of failing with a 403 after
 * the click (#944 OVR-01). Cosmetic by design: every API route re-checks
 * the same permissions server-side.
 */
export async function wpSectionCaps(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  key: WpSectionKey = "overview",
): Promise<WpSectionCaps> {
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  return {
    canSync: canSyncWpSection(permissions, key),
    canEdit: canEditWpSection(permissions, key),
  };
}

export type { WpSectionCaps } from "./wp-routes";
