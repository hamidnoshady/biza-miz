/**
 * Platform-key bridge for one connected business site — publish and theme
 * settings without giving the browser a platform credential.
 */
import { cmsRequest, type CmsConfig, type FetchLike } from "./client";
import { CmsConnectionError, getCmsConfigForBusiness, listCmsConnections } from "./connections";
import { resolvePlatformCmsConfig } from "./platform-control-service";

export type OwnerPublishCollection = "posts" | "pages" | "products";

export type OwnerBridgeResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function platformConfigForBusiness(businessId: string): Promise<{ config: CmsConfig; siteId: string }> {
  const rows = await listCmsConnections(businessId);
  const connection = rows[0];
  if (!connection?.siteId) throw new CmsConnectionError();

  const platform = await resolvePlatformCmsConfig();
  if (!platform?.apiKey) return { config: { baseUrl: connection.baseUrl }, siteId: connection.siteId };

  return {
    siteId: connection.siteId,
    config: { baseUrl: platform.baseUrl, apiKey: platform.apiKey, timeoutMs: platform.timeoutMs },
  };
}

export async function publishOwnerContent(
  businessId: string,
  collection: OwnerPublishCollection,
  id: string,
  opts?: { fetchImpl?: FetchLike },
): Promise<OwnerBridgeResult<{ id: string; collection: OwnerPublishCollection }>> {
  if (!id?.trim()) return { ok: false, error: "bad_request" };
  try {
    const { config, siteId } = await platformConfigForBusiness(businessId);
    if (!config.apiKey) return { ok: false, error: "cms_not_configured" };
    await cmsRequest<{ ok: boolean }>(config, {
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/publish`,
      body: { collection, id },
      fetchImpl: opts?.fetchImpl,
    });
    return { ok: true, data: { id, collection } };
  } catch (error) {
    if (error instanceof CmsConnectionError) return { ok: false, error: "not_connected" };
    return { ok: false, error: "cms_error" };
  }
}

export interface OwnerThemeSettingsView {
  canEdit: boolean;
  fields: { key: string; label: string; help: string | null; required: boolean; secret: boolean; set?: boolean; value?: string }[];
  package: null | { id: string; key: string; name: string };
}

export async function getOwnerThemeSettings(
  businessId: string,
  opts?: { fetchImpl?: FetchLike },
): Promise<OwnerBridgeResult<OwnerThemeSettingsView>> {
  try {
    const { config, siteId } = await platformConfigForBusiness(businessId);
    if (!config.apiKey) return { ok: false, error: "cms_not_configured" };
    const body = await cmsRequest<{ ok: boolean } & OwnerThemeSettingsView>(config, {
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/theme-settings`,
      fetchImpl: opts?.fetchImpl,
    });
    const { canEdit, fields, package: pkg } = body;
    return { ok: true, data: { canEdit, fields, package: pkg } };
  } catch (error) {
    if (error instanceof CmsConnectionError) return { ok: false, error: "not_connected" };
    return { ok: false, error: "cms_error" };
  }
}

export async function saveOwnerThemeSettings(
  businessId: string,
  input: { values?: Record<string, string>; clear?: string[] },
  opts?: { fetchImpl?: FetchLike },
): Promise<OwnerBridgeResult<OwnerThemeSettingsView>> {
  try {
    const { config, siteId } = await platformConfigForBusiness(businessId);
    if (!config.apiKey) return { ok: false, error: "cms_not_configured" };
    const body = await cmsRequest<{ ok: boolean } & OwnerThemeSettingsView>(config, {
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/theme-settings`,
      body: input,
      fetchImpl: opts?.fetchImpl,
    });
    const { canEdit, fields, package: pkg } = body;
    return { ok: true, data: { canEdit, fields, package: pkg } };
  } catch (error) {
    if (error instanceof CmsConnectionError) return { ok: false, error: "not_connected" };
    return { ok: false, error: "cms_error" };
  }
}

/** Used by content-service when the adapter path is not needed. */
export async function siteConfigForBusiness(businessId: string): Promise<CmsConfig> {
  return getCmsConfigForBusiness(businessId);
}
