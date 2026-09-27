import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { fetchCmsRoutingTable } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../_cms-proxy";

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;
  try {
    const routing = await fetchCmsRoutingTable(client.config!, { actor: session.padmin });
    return NextResponse.json({ routing });
  } catch (err) {
    return cmsProxyError(err);
  }
});
