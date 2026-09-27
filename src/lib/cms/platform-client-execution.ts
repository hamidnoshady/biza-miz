/**
 * Execution-plane and deployment calls on `/api/platform/*` (and Payload
 * collection routes the CMS documents for deploy targets).
 *
 * Re-exported from `platform-client.ts` so the control client stays one import
 * surface for console routes and sync jobs.
 */
import { cmsRequest, type CmsConfig, type FetchLike } from "./client";
import { logCmsCall } from "./observability";
import { CmsApiError, CmsNetworkError } from "./client";

export interface PlatformExecutionCallOptions {
  actor?: null | string;
  fetchImpl?: FetchLike;
}

async function withCmsLog<T>(
  operation: string,
  opts: PlatformExecutionCallOptions & { siteId?: null | string },
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    logCmsCall({
      actor: opts.actor ?? null,
      durationMs: Date.now() - started,
      operation,
      outcome: "ok",
      siteId: opts.siteId ?? null,
      status: 200,
    });
    return result;
  } catch (error) {
    const isApi = error instanceof CmsApiError;
    logCmsCall({
      actor: opts.actor ?? null,
      durationMs: Date.now() - started,
      message: `CMS ${operation} failed: ${(error as Error)?.message ?? "unknown"}`,
      operation,
      outcome: isApi ? "api_error" : "network_error",
      siteId: opts.siteId ?? null,
      ...(isApi ? { status: error.status } : {}),
    });
    throw error;
  }
}

function platformConfig(config: CmsConfig): CmsConfig {
  const { siteDomain: _ignored, ...rest } = config;
  return rest;
}

function withTimeout(config: CmsConfig, timeoutMs?: number): CmsConfig {
  return timeoutMs ? { ...config, timeoutMs } : config;
}

// ---------------------------------------------------------------------------
// Theme packages
// ---------------------------------------------------------------------------

export interface CmsThemePackage {
  buildPack: null | string;
  contractVersion: null | string;
  defaultRef: null | string;
  defaultTarget: null | string;
  description: null | string;
  envSchema: unknown[];
  id: string;
  key: string;
  name: string;
  pinnedCommit: null | string;
  proxiesApi: boolean;
  repository: null | string;
  requiredFeature: null | string;
  siteTypes: string[];
  status: string;
  syncedAt: null | string;
  syncedCommitSha: null | string;
  syncError: null | string;
}

export function fetchCmsThemePackages(
  config: CmsConfig,
  opts: PlatformExecutionCallOptions = {},
): Promise<CmsThemePackage[]> {
  return withCmsLog("theme_packages.list", opts, async () => {
    const body = await cmsRequest<{ ok: boolean; packages: CmsThemePackage[] }>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/platform/theme-packages",
    });
    return body.packages ?? [];
  });
}

export function syncCmsThemePackage(
  config: CmsConfig,
  packageId: string,
  input: { ref?: string } = {},
  opts: PlatformExecutionCallOptions = {},
): Promise<{ commit: string; manifest: unknown; package: { id: string; key: string } }> {
  return withCmsLog("theme_packages.sync", opts, () =>
    cmsRequest(platformConfig(withTimeout(config, 12_000)), {
      body: input.ref ? { ref: input.ref } : {},
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/theme-packages/${encodeURIComponent(packageId)}/sync`,
    }),
  );
}

export function publishCmsThemePackage(
  config: CmsConfig,
  packageId: string,
  input: { status?: "draft" | "deprecated" | "published" } = {},
  opts: PlatformExecutionCallOptions = {},
): Promise<{ status: string }> {
  return withCmsLog("theme_packages.publish", opts, () =>
    cmsRequest(platformConfig(config), {
      body: input.status ? { status: input.status } : {},
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/theme-packages/${encodeURIComponent(packageId)}/publish`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Deploy targets (Payload collection + self-test endpoint)
// ---------------------------------------------------------------------------

export interface CmsDeployTargetRow {
  active?: boolean;
  baseUrl?: string;
  id: string;
  key?: string;
  lastSelfTestAt?: null | string;
  lastSelfTestDetail?: null | string;
  lastSelfTestOk?: boolean | null;
  name?: string;
  previewWildcardDomain?: null | string;
  projectUuid?: null | string;
  provider?: string;
  serverUuid?: null | string;
  tokenSummary?: null | string;
}

const SECRET_KEYS = /^(apiToken|api_token|secretValues?)$/i;

/** Strip credential fields before a row crosses to the browser. */
export function sanitizeDeployTarget(doc: Record<string, unknown>): CmsDeployTargetRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (SECRET_KEYS.test(key)) continue;
    out[key] = value;
  }
  return out as unknown as CmsDeployTargetRow;
}

export function fetchCmsDeployTargets(
  config: CmsConfig,
  opts: PlatformExecutionCallOptions = {},
): Promise<CmsDeployTargetRow[]> {
  return withCmsLog("deploy_targets.list", opts, async () => {
    const body = await cmsRequest<{ docs: Record<string, unknown>[] }>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/deploy-targets",
      query: { depth: 0, limit: 100, pagination: false },
    });
    return (body.docs ?? []).map((row) => sanitizeDeployTarget(row));
  });
}

export function createCmsDeployTarget(
  config: CmsConfig,
  data: Record<string, unknown>,
  opts: PlatformExecutionCallOptions = {},
): Promise<CmsDeployTargetRow> {
  return withCmsLog("deploy_targets.create", opts, async () => {
    const body = await cmsRequest<{ doc: Record<string, unknown> }>(platformConfig(config), {
      body: data,
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: "/api/deploy-targets",
    });
    return sanitizeDeployTarget(body.doc ?? {});
  });
}

export function updateCmsDeployTarget(
  config: CmsConfig,
  id: string,
  data: Record<string, unknown>,
  opts: PlatformExecutionCallOptions = {},
): Promise<CmsDeployTargetRow> {
  return withCmsLog("deploy_targets.update", opts, async () => {
    const body = await cmsRequest<{ doc: Record<string, unknown> }>(platformConfig(config), {
      body: data,
      fetchImpl: opts.fetchImpl,
      method: "PATCH",
      path: `/api/deploy-targets/${encodeURIComponent(id)}`,
    });
    return sanitizeDeployTarget(body.doc ?? {});
  });
}

export function deleteCmsDeployTarget(
  config: CmsConfig,
  id: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<void> {
  return withCmsLog("deploy_targets.delete", opts, async () => {
    await cmsRequest(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      method: "DELETE",
      path: `/api/deploy-targets/${encodeURIComponent(id)}`,
    });
  });
}

export function selfTestCmsDeployTarget(
  config: CmsConfig,
  id: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<{ message: string; ok: boolean; servers?: number }> {
  return withCmsLog("deploy_targets.self_test", opts, () =>
    cmsRequest(platformConfig(withTimeout(config, 30_000)), {
      body: { id },
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: "/api/deploy-targets/self-test",
    }),
  );
}

// ---------------------------------------------------------------------------
// Per-site deployment
// ---------------------------------------------------------------------------

export interface CmsDeploymentRow {
  appUuid: null | string;
  attention: null | string;
  commitSha: null | string;
  createdAt: null | string;
  deployedAt: null | string;
  domain: null | string;
  domainMode: string;
  healthCheckedAt: null | string;
  id: string;
  lastError: null | string;
  logTail: null | string;
  needsRedeploy: boolean;
  packageName: null | string;
  previewDomain: null | string;
  previewOpenUrl?: null | string;
  ref: null | string;
  status: string;
  target: null | string;
  targetName: null | string;
  themePackage: null | string;
}

export interface CmsSiteDeploymentState {
  current: CmsDeploymentRow | null;
  deployments: CmsDeploymentRow[];
  needsRedeploy: boolean;
  renderedBy: string;
  update: null | {
    deployedCommit: string;
    latestCommit: string;
    packageRef: string;
    updateAvailable: boolean;
  };
}

export function fetchCmsSiteDeployment(
  config: CmsConfig,
  siteId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<CmsSiteDeploymentState> {
  return withCmsLog("deployment.get", { ...opts, siteId }, async () => {
    const body = await cmsRequest<{ ok: boolean } & CmsSiteDeploymentState>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment`,
    });
    return {
      current: body.current ?? null,
      deployments: body.deployments ?? [],
      needsRedeploy: body.needsRedeploy === true,
      renderedBy: body.renderedBy ?? "platform",
      update: body.update ?? null,
    };
  });
}

export function createCmsSiteDeployment(
  config: CmsConfig,
  siteId: string,
  body: { domainMode?: string; package: string; ref?: string; target?: string },
  opts: PlatformExecutionCallOptions = {},
): Promise<{ deployment: string; ref: string; status: string }> {
  return withCmsLog("deployment.create", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(config), {
      body,
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment`,
    }),
  );
}

export function redeployCmsSiteDeployment(
  config: CmsConfig,
  siteId: string,
  body: { domainMode?: string; ref?: string } = {},
  opts: PlatformExecutionCallOptions = {},
): Promise<{ deployment: string; ref: string; status: string }> {
  return withCmsLog("deployment.redeploy", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(config), {
      body,
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment/redeploy`,
    }),
  );
}

export function rollbackCmsSiteDeployment(
  config: CmsConfig,
  siteId: string,
  deploymentId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<{ commit: string; deployment: string; status: string }> {
  return withCmsLog("deployment.rollback", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(config), {
      body: { deployment: deploymentId },
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment/rollback`,
    }),
  );
}

export function pollCmsSiteDeployment(
  config: CmsConfig,
  siteId: string,
  deploymentId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<{ message?: string; ok: boolean; status: string }> {
  return withCmsLog("deployment.poll", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(withTimeout(config, 60_000)), {
      body: { deployment: deploymentId },
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment/poll`,
    }),
  );
}

export function verifyCmsSiteDeployment(
  config: CmsConfig,
  siteId: string,
  deploymentId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<{ message: string; ok: boolean }> {
  return withCmsLog("deployment.verify", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(withTimeout(config, 30_000)), {
      body: { deployment: deploymentId },
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment/verify`,
    }),
  );
}

export function stopCmsSiteDeployment(
  config: CmsConfig,
  siteId: string,
  deploymentId: string,
  input: { reason?: string } = {},
  opts: PlatformExecutionCallOptions = {},
): Promise<{ applicationStopped: boolean; message: string; ok: boolean }> {
  return withCmsLog("deployment.stop", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(withTimeout(config, 30_000)), {
      body: { deployment: deploymentId, ...input },
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment/stop`,
    }),
  );
}

export function revertCmsSiteDeployments(
  config: CmsConfig,
  siteId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<{ failed: string[]; reverted: number }> {
  return withCmsLog("deployment.revert", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(withTimeout(config, 60_000)), {
      body: {},
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/deployment/revert`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Routing & SaaS / billing reads
// ---------------------------------------------------------------------------

export function fetchCmsRoutingTable(
  config: CmsConfig,
  opts: PlatformExecutionCallOptions = {},
): Promise<{ generatedAt: string; routes: { host: string; upstream: string }[] }> {
  return withCmsLog("routing", opts, () =>
    cmsRequest(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/platform/routing",
    }),
  );
}

export type CmsSaasOverview = Record<string, unknown>;

export function fetchCmsSaasOverview(
  config: CmsConfig,
  input: { days?: number } = {},
  opts: PlatformExecutionCallOptions = {},
): Promise<CmsSaasOverview> {
  return withCmsLog("saas.overview", opts, async () => {
    const body = await cmsRequest<{ ok: boolean; overview: CmsSaasOverview }>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/platform/saas/overview",
      query: { days: input.days },
    });
    return body.overview ?? body;
  });
}

export type CmsBillingHealth = Record<string, unknown>;

export function fetchCmsBillingHealth(
  config: CmsConfig,
  opts: PlatformExecutionCallOptions = {},
): Promise<CmsBillingHealth> {
  return withCmsLog("billing.health", opts, () =>
    cmsRequest(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/platform/billing/health",
    }),
  );
}

export function fetchCmsSiteBilling(
  config: CmsConfig,
  siteId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<Record<string, unknown>> {
  return withCmsLog("sites.billing", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/billing`,
    }),
  );
}

export function fetchCmsSiteEntitlement(
  config: CmsConfig,
  siteId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<Record<string, unknown>> {
  return withCmsLog("sites.entitlement", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/entitlement`,
    }),
  );
}

export function fetchCmsSiteQuota(
  config: CmsConfig,
  siteId: string,
  opts: PlatformExecutionCallOptions = {},
): Promise<Record<string, unknown>> {
  return withCmsLog("sites.quota", { ...opts, siteId }, () =>
    cmsRequest(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/quota`,
    }),
  );
}

export function runCmsPaymentsSelfTest(
  config: CmsConfig,
  body: Record<string, unknown> = {},
  opts: PlatformExecutionCallOptions = {},
): Promise<Record<string, unknown>> {
  return withCmsLog("payments.self_test", opts, () =>
    cmsRequest(platformConfig(withTimeout(config, 30_000)), {
      body,
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: "/api/payments/self-test",
    }),
  );
}

export function runCmsStorageSelfTest(
  config: CmsConfig,
  body: Record<string, unknown> = {},
  opts: PlatformExecutionCallOptions = {},
): Promise<Record<string, unknown>> {
  return withCmsLog("storage.self_test", opts, () =>
    cmsRequest(platformConfig(withTimeout(config, 30_000)), {
      body,
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: "/api/storage-connections/self-test",
    }),
  );
}
