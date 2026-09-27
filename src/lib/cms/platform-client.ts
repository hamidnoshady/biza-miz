/**
 * The typed client for the CMS's platform control API (`/api/platform/*` over
 * there — see `docs/platform-control-api.md` in the eshobe-cms repo).
 *
 * It rides on `client.ts`'s `cmsRequest`, so the URL building, the `Authorization`
 * header, the 8-second timeout and the `CmsApiError` / `CmsNetworkError` split are
 * shared with every other CMS call this app makes. What this module adds is the
 * two things a *control* call needs and a site call does not:
 *
 *  - **No `Host` override.** A platform call carries no `siteDomain`, so `Host`
 *    stays the control plane's own name. That is what keeps `/api/platform/*` on
 *    the control-plane block of the CMS's Caddy config, where it 404s on every
 *    customer domain. Passing a site domain here would route an operator endpoint
 *    onto a shop's origin.
 *  - **Every call is logged.** `withCmsLog` wraps each operation so its latency and
 *    outcome land in the OpenObserve stream (`src/lib/cms/observability.ts`)
 *    whether it succeeded, was refused, or never reached the CMS at all. The
 *    console's «پایش سایت‌ساز» tab is built entirely out of those records plus the
 *    CMS's own feed.
 *
 * The client never *decides* anything: a failure is thrown, and the caller
 * (`platform-sync.ts`, a console route) chooses whether that means "show stale
 * mirror data" or "refuse the write". A read from the CMS is best-effort and a
 * write is never reported as applied unless the CMS answered 2xx — the same rule
 * `client.ts` states for the site-scoped half.
 */
import { cmsRequest, CmsApiError, CmsNetworkError, type CmsConfig, type FetchLike } from "./client";
import { logCmsCall } from "./observability";
import type { CmsSiteRow } from "./platform-control";

export interface PlatformCallOptions {
  actor?: null | string;
  fetchImpl?: FetchLike;
}

/**
 * One instrumented control call.
 *
 * The log record is written in a `finally`-shaped path rather than only on success,
 * because the interesting records are the failures: "the overview call has been
 * answering 502 since the deploy" is the sentence this exists to make available.
 */
async function withCmsLog<T>(
  operation: string,
  opts: PlatformCallOptions & { siteId?: null | string },
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

/** A platform call must never carry a site's domain as `Host` (see this file's header). */
function platformConfig(config: CmsConfig): CmsConfig {
  const { siteDomain: _ignored, ...rest } = config;
  return rest;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * The fleet report. Mirrors the CMS's `PlatformOverview`, but typed loosely on
 * purpose for the nested count objects: the CMS may add a figure, and a client
 * that fails to compile because the *server* learned something new is worse than
 * one that ignores it. The fields the console actually renders are named.
 */
export interface CmsOverview {
  commerce: {
    byStatus: Record<string, number>;
    orders: number;
    revenue: { code: string; minorTotal: number; orders: number }[];
    revenueTruncated: boolean;
    windowDays: number;
  };
  content: Record<string, number>;
  gateways: {
    moduleEnabled: boolean;
    rows: number;
    table: {
      allowed: boolean;
      enabled: number;
      failingSelfTest: number;
      gateway: string;
      label: string;
      passingSelfTest: number;
      rows: number;
    }[];
  };
  generatedAt: string;
  infrastructure: {
    cdnZones: number;
    jobs: { available: boolean; completed: number; failed: number; queued: number };
    keys: { disabled: number; total: number };
    sitesWithAliases: number;
    storage: {
      bucket: null | string;
      enabled: boolean;
      endpoint: null | string;
      rows: number;
      usable: boolean;
    };
    users: number;
  };
  sites: {
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    createdInWindow: number;
    total: number;
    unverified: number;
    verified: number;
  };
}

export function fetchCmsOverview(
  config: CmsConfig,
  input: { days?: number } = {},
  opts: PlatformCallOptions = {},
): Promise<CmsOverview> {
  return withCmsLog("overview", opts, async () => {
    const body = await cmsRequest<{ ok: boolean; overview: CmsOverview }>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/platform/overview",
      query: { days: input.days },
    });
    return body.overview;
  });
}

export interface CmsSitesPage {
  page: number;
  sites: CmsSiteRow[];
  totalDocs: number;
  totalPages: number;
}

export function fetchCmsSites(
  config: CmsConfig,
  input: { limit?: number; page?: number; q?: string; status?: string } = {},
  opts: PlatformCallOptions = {},
): Promise<CmsSitesPage> {
  return withCmsLog("sites.list", opts, () =>
    cmsRequest<CmsSitesPage>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/platform/sites",
      query: { limit: input.limit, page: input.page, q: input.q, status: input.status },
    }),
  );
}

/**
 * Every site, paged through.
 *
 * The mirror has to hold the *whole* list or its delete pass would remove sites
 * that merely fell off page one — so this walks the pages rather than taking the
 * first, and stops at a page cap so a runaway loop cannot hold a tick open
 * forever.
 */
export async function fetchAllCmsSites(
  config: CmsConfig,
  opts: PlatformCallOptions & { pageSize?: number } = {},
): Promise<{ complete: boolean; sites: CmsSiteRow[] }> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
  const MAX_PAGES = 40; // 2,000 sites — far beyond this platform, and still bounded
  const sites: CmsSiteRow[] = [];
  let page = 1;
  for (;;) {
    const result = await fetchCmsSites(config, { limit: pageSize, page }, opts);
    sites.push(...result.sites);
    if (page >= (result.totalPages || 1) || result.sites.length === 0) {
      return { complete: true, sites };
    }
    if (page >= MAX_PAGES) return { complete: false, sites };
    page += 1;
  }
}

export function fetchCmsSite(
  config: CmsConfig,
  siteId: string,
  opts: PlatformCallOptions = {},
): Promise<CmsSiteRow> {
  return withCmsLog("sites.get", { ...opts, siteId }, async () => {
    const body = await cmsRequest<{ ok: boolean; site: CmsSiteRow }>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: `/api/platform/sites/${encodeURIComponent(siteId)}`,
    });
    return body.site;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CmsSitePatch {
  availableLocales?: string[];
  defaultLocale?: string;
  domainVerified?: boolean;
  domains?: { hostname: string; id?: string; verified: boolean }[];
  name?: string;
  status?: "active" | "archived" | "suspended";
  type?: "business" | "portfolio" | "store";
}

export function patchCmsSite(
  config: CmsConfig,
  siteId: string,
  patch: CmsSitePatch,
  opts: PlatformCallOptions = {},
): Promise<CmsSiteRow> {
  return withCmsLog("sites.patch", { ...opts, siteId }, async () => {
    const body = await cmsRequest<{ ok: boolean; site: CmsSiteRow }>(platformConfig(config), {
      body: patch,
      fetchImpl: opts.fetchImpl,
      method: "PATCH",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}`,
    });
    return body.site;
  });
}

// ---------------------------------------------------------------------------
// The event feed
// ---------------------------------------------------------------------------

export interface CmsEventsPage {
  cursor: null | string;
  events: {
    at: string;
    data?: Record<string, unknown>;
    id: string;
    kind: string;
    level: string;
    message: string;
    siteDomain: null | string;
    siteId: null | string;
  }[];
  since: string;
}

export function fetchCmsEvents(
  config: CmsConfig,
  input: { limit?: number; since?: null | string } = {},
  opts: PlatformCallOptions = {},
): Promise<CmsEventsPage> {
  return withCmsLog("events", opts, () =>
    cmsRequest<CmsEventsPage>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: "/api/platform/events",
      query: { limit: input.limit, since: input.since ?? undefined },
    }),
  );
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface CmsSnapshot {
  counts: Record<string, number>;
  documents: Record<string, Record<string, Record<string, unknown>[]>>;
  generatedAt: string;
  locales: string[];
  site: {
    availableLocales: string[];
    defaultLocale: string;
    domain: string;
    id: string;
    name: string;
    status: string;
    type: string;
  };
  truncated: string[];
}

export function exportCmsSnapshot(
  config: CmsConfig,
  siteId: string,
  input: { collections?: string[] } = {},
  opts: PlatformCallOptions = {},
): Promise<CmsSnapshot> {
  return withCmsLog("snapshot.export", { ...opts, siteId }, async () => {
    const body = await cmsRequest<{ ok: boolean; snapshot: CmsSnapshot }>(platformConfig(config), {
      fetchImpl: opts.fetchImpl,
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/snapshot`,
      query: { collections: input.collections?.join(",") },
    });
    return body.snapshot;
  });
}

export interface CmsImportResult {
  dryRun: boolean;
  errors: { collection: string; key: null | string; locale: string; message: string }[];
  plan: { action: "create" | "skip" | "update"; collection: string; key: null | string }[];
  summary: { created: number; skipped: number; updated: number };
}

export function importCmsSnapshot(
  config: CmsConfig,
  siteId: string,
  input: { collections?: string[]; dryRun?: boolean; force?: boolean; snapshot: unknown },
  opts: PlatformCallOptions = {},
): Promise<CmsImportResult> {
  return withCmsLog("snapshot.import", { ...opts, siteId }, () =>
    cmsRequest<CmsImportResult>(platformConfig(config), {
      body: {
        collections: input.collections,
        dryRun: input.dryRun === true,
        force: input.force === true,
        snapshot: input.snapshot,
      },
      fetchImpl: opts.fetchImpl,
      method: "POST",
      path: `/api/platform/sites/${encodeURIComponent(siteId)}/snapshot`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface CmsVerifyResult {
  error?: string;
  ok: boolean;
  sites?: number;
  /** Which failure class, so the console can say something useful in Persian. */
  reason?: "forbidden" | "not_found" | "server_error" | "unreachable";
}

/**
 * Does this address + key actually work?
 *
 * `overview` rather than a dedicated ping: the point of the check is that the
 * credential can do the thing the console needs, and a health endpoint that
 * answers 200 for an unauthorized caller would prove nothing. The failure is
 * *classified* rather than passed through, because "۴۰۳" on a settings page is
 * not an instruction and «کلید پلتفرم پذیرفته نشد» is.
 */
export async function verifyCmsConnection(
  config: CmsConfig,
  opts: PlatformCallOptions = {},
): Promise<CmsVerifyResult> {
  try {
    const overview = await fetchCmsOverview(config, { days: 1 }, opts);
    return { ok: true, sites: overview.sites.total };
  } catch (error) {
    if (error instanceof CmsApiError) {
      return {
        error: error.message,
        ok: false,
        reason:
          error.status === 403 || error.status === 401
            ? "forbidden"
            : error.status === 404
              ? "not_found"
              : "server_error",
      };
    }
    if (error instanceof CmsNetworkError) {
      return { error: error.message, ok: false, reason: "unreachable" };
    }
    return { error: (error as Error)?.message ?? "unknown", ok: false, reason: "server_error" };
  }
}

export * from "./platform-client-execution";
