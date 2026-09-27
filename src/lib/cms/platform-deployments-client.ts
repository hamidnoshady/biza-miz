/**
 * Platform deployment API for the business CMS manager (theme packages,
 * edge deployments). Uses the platform key without a site Host header.
 */
import { cmsRequest, CmsApiError, CmsNetworkError, type CmsConfig, type FetchLike } from "./client";
import { logCmsCall } from "./observability";

export interface ThemePackageRow {
  id: string;
  key: string;
  name: string;
  status: string;
  siteTypes: string[];
  description?: string | null;
}

export interface SiteDeploymentStatus {
  /** The live or in-progress deployment row from the CMS (`GET …/deployment`). */
  current: Record<string, unknown> | null;
  deployments?: Record<string, unknown>[];
  renderedBy?: string;
  needsRedeploy?: boolean;
  attention?: string | null;
}

function platformConfig(config: CmsConfig): CmsConfig {
  const { siteDomain: _ignored, ...rest } = config;
  return rest;
}

async function withLog<T>(operation: string, siteId: string | null, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    logCmsCall({ actor: null, durationMs: Date.now() - started, operation, outcome: "ok", siteId, status: 200 });
    return result;
  } catch (error) {
    const isApi = error instanceof CmsApiError;
    logCmsCall({
      actor: null,
      durationMs: Date.now() - started,
      message: (error as Error)?.message ?? "unknown",
      operation,
      outcome: isApi ? "api_error" : "network_error",
      siteId,
      ...(isApi ? { status: error.status } : {}),
    });
    throw error;
  }
}

export function listThemePackages(
  config: CmsConfig,
  opts?: { siteType?: string; fetchImpl?: FetchLike },
): Promise<{ packages: ThemePackageRow[] }> {
  return withLog("theme-packages.list", null, () =>
    cmsRequest<{ packages: ThemePackageRow[] }>(platformConfig(config), {
      path: "/api/platform/theme-packages",
      fetchImpl: opts?.fetchImpl,
    }).then((body) => {
      const packages = body.packages ?? [];
      if (!opts?.siteType) return { packages };
      return {
        packages: packages.filter(
          (pkg) => pkg.status === "published" && (!pkg.siteTypes?.length || pkg.siteTypes.includes(opts.siteType!)),
        ),
      };
    }),
  );
}

export function getDeployment(
  config: CmsConfig,
  siteId: string,
  opts?: { fetchImpl?: FetchLike },
): Promise<SiteDeploymentStatus> {
  return withLog("deployment.get", siteId, () =>
    cmsRequest<SiteDeploymentStatus>(platformConfig(config), {
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment`,
      fetchImpl: opts?.fetchImpl,
    }),
  );
}

export function createEdgeDeployment(
  config: CmsConfig,
  siteId: string,
  input: { package: string; ref?: string | null },
  opts?: { fetchImpl?: FetchLike },
): Promise<{ deployment: string; status: string }> {
  return withLog("deployment.create", siteId, () =>
    cmsRequest<{ ok: boolean; deployment: string; status: string }>(platformConfig(config), {
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment`,
      body: { package: input.package, ref: input.ref ?? undefined, domainMode: "edge" },
      fetchImpl: opts?.fetchImpl,
    }).then((body) => ({ deployment: body.deployment, status: body.status })),
  );
}

export function pollDeployment(
  config: CmsConfig,
  siteId: string,
  deploymentId: string,
  opts?: { fetchImpl?: FetchLike },
): Promise<{ deployment: Record<string, unknown> }> {
  return withLog("deployment.poll", siteId, () =>
    cmsRequest<{ deployment: Record<string, unknown> }>(platformConfig(config), {
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment/poll`,
      body: { deployment: deploymentId },
      fetchImpl: opts?.fetchImpl,
    }),
  );
}

export function mapDeploymentError(error: unknown): string {
  if (error instanceof CmsNetworkError) return "cms_unreachable";
  if (error instanceof CmsApiError) {
    if (error.status === 404) return "not_found";
    if (error.status === 403) return "forbidden";
  }
  return "cms_error";
}
