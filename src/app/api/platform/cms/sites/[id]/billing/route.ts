import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { fetchCmsSiteBilling, fetchCmsSiteEntitlement, fetchCmsSiteQuota } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../../../_cms-proxy";

export const GET = withPlatformScope(async (_request, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  const { id } = await ctx.params;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;
  try {
    const [billing, entitlement, quota] = await Promise.all([
      fetchCmsSiteBilling(client.config!, id, { actor: session.padmin }),
      fetchCmsSiteEntitlement(client.config!, id, { actor: session.padmin }),
      fetchCmsSiteQuota(client.config!, id, { actor: session.padmin }),
    ]);
    return NextResponse.json({ billing, entitlement, quota });
  } catch (err) {
    return cmsProxyError(err);
  }
});
