import { listCmsConnections } from "./connections";
import { resolvePlatformCmsConfig } from "./platform-control-service";
import type { CmsConfig } from "./client";

export type OwnerApiContext = { ok: true; config: CmsConfig; siteId: string } | { ok: false; error: string };

export async function ownerPlatformContext(businessId: string): Promise<OwnerApiContext> {
  const connection = (await listCmsConnections(businessId))[0];
  if (!connection) return { ok: false, error: "not_connected" };
  const platform = await resolvePlatformCmsConfig();
  if (!platform?.apiKey) return { ok: false, error: "cms_not_configured" };
  return {
    ok: true,
    siteId: connection.siteId,
    config: { baseUrl: platform.baseUrl, apiKey: platform.apiKey, timeoutMs: platform.timeoutMs },
  };
}
