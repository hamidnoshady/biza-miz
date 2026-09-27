/**
 * What «مدیریت وب‌سایت» knows about a business's two website systems.
 *
 * All reads are local. A down CMS must not make the app's own menu slow or
 * empty. The home variant also returns the setup row from the same read pass,
 * avoiding the duplicate setup query and mismatched progress/status snapshot
 * the old overview could produce while a site was being provisioned.
 */
import { query } from "../db";
import { fetchSiteDescriptor } from "../cms/client";
import { CmsConnectionError, getCmsConfigForBusiness } from "../cms/connections";
import { cmsWebsiteState } from "../cms/website-service";
import { getWebsiteSetup } from "./setup-service";
import type { SiteType, WebsiteSetupState } from "./setup";
import type { CmsSiteType } from "@/app/(app)/websites/website-routes";

export interface WebsiteManagersState {
  cms: {
    connected: boolean;
    domain: string | null;
    setupStep: WebsiteSetupState["stage"] | null;
    siteType: CmsSiteType | null;
  };
  wp: {
    connected: boolean;
    storeCount: number;
  };
}

function normalizeSiteType(value: string | null | undefined): CmsSiteType | null {
  if (value === "business" || value === "portfolio" || value === "store") return value;
  return null;
}

async function resolveCmsSiteType(businessId: string, connected: boolean, setupType: SiteType): Promise<CmsSiteType | null> {
  if (!connected) return normalizeSiteType(setupType);
  try {
    const config = await getCmsConfigForBusiness(businessId);
    const descriptor = await fetchSiteDescriptor(config);
    const fromDescriptor = normalizeSiteType(descriptor.type);
    if (fromDescriptor) return fromDescriptor;
  } catch (error) {
    if (!(error instanceof CmsConnectionError)) {
      // Best-effort only — fall back to wizard choice.
    }
  }
  return normalizeSiteType(setupType);
}

export interface WebsiteHomeState {
  managers: WebsiteManagersState;
  setup: WebsiteSetupState;
}

/**
 * Read the app-home snapshot once. `websiteManagersState` intentionally wraps
 * this so the sidebar/API and the server-rendered overview continue to use the
 * exact same connection rules.
 */
export async function websiteHomeState(businessId: string): Promise<WebsiteHomeState> {
  const [connection, setup, stores] = await Promise.all([
    cmsWebsiteState(businessId),
    getWebsiteSetup(businessId),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM integration_connections
        WHERE business_id = $1 AND provider = 'woocommerce'`,
      [businessId],
    ),
  ]);

  const storeCount = Number(stores.rows[0]?.count ?? 0);
  const cmsConnected = Boolean(connection);
  const siteType = await resolveCmsSiteType(businessId, cmsConnected, setup.siteType);
  const managers: WebsiteManagersState = {
    cms: {
      connected: cmsConnected,
      domain: connection?.siteDomain ?? setup.domain,
      // A business that has never opened the wizard has no step at all; one
      // that has, but has no site yet, shows where it got to.
      setupStep: connection ? "built" : setup.domain || setup.stage !== "domain" ? setup.stage : null,
      siteType,
    },
    // Paused/error connections still count as connected: their manager is the
    // place where the owner diagnoses or resumes them. Deleting disconnects.
    wp: { connected: storeCount > 0, storeCount },
  };

  return { managers, setup };
}

export async function websiteManagersState(businessId: string): Promise<WebsiteManagersState> {
  return (await websiteHomeState(businessId)).managers;
}
