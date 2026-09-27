import { NextResponse } from "next/server";

import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { fetchCmsBillingHealth } from "@/lib/cms/platform-client";
import { getCmsControlConfig } from "@/lib/cms/platform-control-service";
import { query, withoutTenantScope } from "@/lib/db";
import { cmsProxyError, requireCmsClient } from "../_cms-proxy";

async function localEntitlementOutboxSummary() {
  return withoutTenantScope("cms-billing-sync-read", async () => {
    const { rows } = await query<{
      dead: string;
      failed: string;
      pending: string;
      sent: string;
      last_delivered_at: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
         COUNT(*) FILTER (WHERE status = 'dead_letter')::text AS dead,
         COUNT(*) FILTER (WHERE status = 'sent')::text AS sent,
         MAX(delivered_at) FILTER (WHERE status = 'sent') AS last_delivered_at
       FROM cms_entitlement_outbox`,
    );
    const row = rows[0];
    return {
      dead: Number(row?.dead ?? 0),
      failed: Number(row?.failed ?? 0),
      lastSentAt: row?.last_delivered_at ?? null,
      pending: Number(row?.pending ?? 0),
      sent: Number(row?.sent ?? 0),
    };
  });
}

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;

  const config = await getCmsControlConfig();
  const local = await localEntitlementOutboxSummary();

  const client = await requireCmsClient(session.padmin);
  let cmsHealth: Record<string, unknown> | null = null;
  let cmsHealthError: string | null = null;
  if (client.error) {
    cmsHealthError = "cms_not_configured";
  } else {
    try {
      cmsHealth = await fetchCmsBillingHealth(client.config!, { actor: session.padmin });
    } catch (err) {
      cmsHealthError = (err as Error)?.message ?? "cms_error";
    }
  }

  return NextResponse.json({
    centralBillingHref: "/platform/billing",
    cmsHealth,
    cmsHealthError,
    config: {
      billingEntitlementKeyId: config.billingEntitlementKeyId,
      billingEntitlementSecretHint: config.billingEntitlementSecretHint,
    },
    localOutbox: local,
  });
});
