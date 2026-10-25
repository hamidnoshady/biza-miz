import { redirect } from "next/navigation";
import { requireMember } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures } from "@/lib/features";
import type { Industry } from "@/lib/industries";
import { visibleConnectionKinds, resolveConnectionKind } from "@/lib/connection-kinds";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ConnectionsManager } from "./connections-manager";

/**
 * «اتصال‌های فنی» — the one hub for every technical connection this business
 * has: the desktop install, WordPress/WooCommerce, the Eshobe CMS site, Holoo,
 * the remote server sync, and developer/assistant access.
 *
 * A shell utility, not an app (src/lib/apps.ts): never badged, never gated by
 * availability, and deliberately not gated as a whole by any feature either.
 * The tabs have different entitlements — and desktop pairing is not an
 * entitlement at all — so gating the page would hide the free thing behind
 * the paid ones. Each tab carries its own lock instead.
 *
 * The product screens that *use* a connection manage their own subject only:
 * «مدیریت وب‌سایت» manages the sites, the ledger keeps the books. Any
 * connection surface anywhere else redirects to a tab here.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { session, membership, error } = await requireMember();
  if (error || !session) redirect("/login");

  const { tab } = await searchParams;

  const [features, { rows }] = await withTenant(session.businessId, () =>
    Promise.all([
      effectiveFeatures(session.businessId),
      query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [session.businessId]),
    ]),
  );
  const industry = rows[0]?.industry ?? "food_service";

  const kinds = visibleConnectionKinds({ role: session.role, industry, permissions: membership.permissions });
  // A role with nothing to connect (a cashier, a waiter) has no page here at
  // all rather than an empty one.
  if (kinds.length === 0) redirect("/dashboard");

  const active = resolveConnectionKind(tab, kinds)!;

  return (
    <PageShell>
      <PageHeader
        title="اتصال‌های فنی"
        description="همهٔ اتصال‌های فنی این کسب‌وکار در یک‌جا: برنامهٔ دسکتاپ، وردپرس و ووکامرس، سایت‌ساز بیزامیز، هلو، سرور راه دور و دسترسی توسعه‌دهندگان — همراه با آزمایش اتصال و مدیریت کلیدها."
        actions={<KnowledgeHelpButton section="connections" />}
      />
      <ConnectionsManager
        kinds={kinds}
        canRotateTokens={membership.permissions.has(PERMISSIONS.apiManage)}
        initialTab={active}
        // A «?tab=» link named a section, so a phone opens that section rather
        // than the list it sits in — the link is the whole point of the param.
        initialOpen={Boolean(tab)}
        features={{
          integrations: Boolean(features.integrations),
          api_platform: Boolean(features.api_platform),
          site_cloud_sync: Boolean(features.site_cloud_sync),
        }}
      />
    </PageShell>
  );
}
