import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { fetchCmsThemePackages } from "@/lib/cms/platform-client";
import { cmsProxyError, requireCmsClient } from "../_cms-proxy";

export const GET = withPlatformScope(async () => {
  const { session, error } = await requirePlatformAdmin();
  if (error) return error;
  const client = await requireCmsClient(session.padmin);
  if (client.error) return client.error;
  try {
    const packages = await fetchCmsThemePackages(client.config!, { actor: session.padmin });
    return NextResponse.json({ packages });
  } catch (err) {
    return cmsProxyError(err);
  }
});
