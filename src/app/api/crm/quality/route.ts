import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { crmDataQuality } from "@/lib/crm-data-quality";
import { countPendingExternalProfiles } from "@/lib/crm-external-identity";

/**
 * The data-quality workspace's own read — `مسائل داده`.
 *
 * `crm.merge`, which is the same key the workspace's section gate requires:
 * deciding that two rows are one person, and deciding that a record is unusable,
 * are the same judgement about the same data. The route and the screen therefore
 * cannot disagree about who is allowed to look.
 *
 * It returns the *issues* and one cheap count (identities waiting for a
 * decision). The duplicate pairs are deliberately **not** computed here: the
 * detector walks party pairs with a subquery per side, and the workspace's
 * duplicate view already asks for them under its own request — running the scan
 * twice on every visit to answer a badge would be the expensive way to say the
 * same thing. The identities count is one indexed `count(*)`.
 *
 * Nothing here is a write and nothing here is a merge: the workspace lists gaps
 * and links to the screen that fixes them, and every fix goes through that
 * screen's own permission.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.crmMerge);
  if (error) return error;

  const [issues, pendingIdentities] = await Promise.all([
    crmDataQuality(session.businessId),
    countPendingExternalProfiles(session.businessId).catch(() => 0),
  ]);

  return NextResponse.json({
    issues,
    counts: {
      /** Identities waiting for a human decision — the reconciliation view's own number. */
      pendingIdentities,
    },
  });
});
