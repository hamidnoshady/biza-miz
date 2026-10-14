/**
 * Platform-key bridge for one connected business site — publish and theme
 * settings without giving the browser a platform credential.
 */
import { CmsApiError, cmsRequest, type CmsConfig, type FetchLike } from "./client";
import { CmsConnectionError, listCmsConnections } from "./connections";
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

export type OwnerEmbedCollection = "posts" | "pages";

/**
 * One-time URL that opens a single CMS admin document (a post or a page, or the
 * `create` form when `id` is absent) inside the dashboard's edit modal.
 *
 * `canPublish` is this app's own decision about the signed-in member (`cms.publish`) and is
 * what picks the CMS-side service user — the CMS trusts it exactly as far as it trusts our
 * platform key. The returned URL is a credential for ~60 seconds: it goes to the browser's
 * iframe once and is never stored or logged here. It must point at the CMS we dialled; a
 * response naming any other origin is refused rather than framed.
 */
export async function createOwnerEmbedSession(
  businessId: string,
  input: { collection: OwnerEmbedCollection; id?: string; canPublish: boolean },
  opts?: { fetchImpl?: FetchLike },
): Promise<OwnerBridgeResult<{ url: string }>> {
  try {
    const { config, siteId } = await platformConfigForBusiness(businessId);
    if (!config.apiKey) return { ok: false, error: "cms_not_configured" };
    const body = await cmsRequest<{ ok?: boolean; url?: unknown }>(config, {
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/embed-session`,
      body: {
        collection: input.collection,
        ...(input.id ? { id: input.id } : {}),
        canPublish: input.canPublish === true,
      },
      fetchImpl: opts?.fetchImpl,
    });
    if (typeof body.url !== "string") return { ok: false, error: "cms_error" };
    const url = new URL(body.url);
    if (url.origin !== new URL(config.baseUrl).origin || !/^https?:$/.test(url.protocol)) {
      return { ok: false, error: "cms_error" };
    }
    return { ok: true, data: { url: url.toString() } };
  } catch (error) {
    if (error instanceof CmsConnectionError) return { ok: false, error: "not_connected" };
    if (error instanceof CmsApiError && error.status === 404) {
      // The CMS answers a missing document or site in Persian ("سند …", "سایت …"); a bare
      // "Route not found" is a CMS that predates embedded editing.
      return { ok: false, error: /سند|سایت/.test(error.message) ? "not_found" : "cms_old_version" };
    }
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

