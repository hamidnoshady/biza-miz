/**
 * Platform reporting is an adapter, not a reporting engine. The route guard
 * authenticates a platform operator before entering this boundary. Resolve only
 * the business identity under platform scope; ALL report reads run withTenant.
 * Never seed saved reports, decrypt credentials into responses, or call writes.
 */
import { query, withTenant } from "./db";
import type { Industry } from "./industries";
import { APPS } from "./apps";
import { effectiveAppAvailability } from "./app-availability-service";
import { readDeploymentProfile } from "./deployment-mode";
import { resolveCapability } from "./capabilities";
import { effectiveFeatures } from "./features";
import { getSetting, SETTING_KEYS } from "./settings";
import { businessToday, getBusinessDayStatus } from "./business-day-service";
import {
  standardReportsFor, reportViewsFor, reportShape, reportConfigIsMoney, REPORT_GROUP_LABELS,
  REPORT_VIEWS, previousPeriodRange, type ReportConfig,
} from "./reports";
import { getBusinessOverview, getProfitAndLoss, runCustomReportQuery } from "./reports-service";
import { branchScope, BUSINESS_WIDE_SCOPE, type ReportScope } from "./report-scope";
import { runStandardReport } from "./standard-report-service";
import { crmOverview } from "./crm-overview";
import { growthOverview } from "./growth-overview";
import { websiteManagersState } from "./website/managers-service";
import { cmsWebsiteOverview } from "./cms/website-service";
import { wpOverviewStats } from "./integrations/wp-manager-service";
import { businessUsage } from "./platform-service";
import { getSyncHealth } from "./sync-health-service";
import { getBackupHealth } from "./backup-service";
import { businessDesktopCompliance } from "./desktop-release-service";
import { PlatformReportError, type PlatformReportOptions } from "./platform-report-request";
import { pageReportDetails } from "./report-detail-page";
import { z } from "zod";

/** No raw exception text: provider errors may contain secrets or remote payloads. */
async function panel<T>(read: () => Promise<T>) {
  try { return { data: await read(), error: null }; }
  catch { return { data: null, error: "report_unavailable" }; }
}

export async function withBusinessReporting<T>(
  businessId: string, options: PlatformReportOptions,
  read: (context: Awaited<ReturnType<typeof reportingContext>>) => Promise<T>,
): Promise<T> {
  if (!z.string().uuid().safeParse(businessId).success) throw new PlatformReportError("not_found", 404);
  // A small identity lookup, NOT getBusiness's bypass-scoped operational counts.
  const { rows } = await query<{ id: string; industry: Industry }>(
    "SELECT id, industry FROM businesses WHERE id = $1", [businessId],
  );
  if (!rows[0]) throw new PlatformReportError("not_found", 404);
  return withTenant(rows[0].id, async () => read(await reportingContext(rows[0], options)));
}

async function reportingContext(business: { id: string; industry: Industry }, options: PlatformReportOptions) {
  const businessId = business.id;
  if (options.locationId) {
    const branch = await query<{ id: string }>(
      "SELECT id FROM locations WHERE id = $1 AND business_id = $2", [options.locationId, businessId],
    );
    if (!branch.rows.length) throw new PlatformReportError("invalid_location");
  }
  const [availability, deployment, features] = await Promise.all([
    effectiveAppAvailability(businessId), readDeploymentProfile(businessId), effectiveFeatures(businessId),
  ]);
  const apps = APPS.filter((app) => availability[app.key].usable &&
    resolveCapability(app.capability, { deployment: deployment.profile }).available).map((app) => app.key);
  const accounting = apps.includes("accounting") && features.reporting !== false;
  const reports = accounting ? standardReportsFor(business.industry) : [];
  return { businessId, industry: business.industry, options, apps, reports, accounting };
}
type Context = Awaited<ReturnType<typeof reportingContext>>;

export async function platformReportSection(context: Context, section: string) {
  const { businessId, industry, options, apps, reports, accounting } = context;
  switch (section) {
    case "day":
      return { today: options.locationId ? (await getBusinessDayStatus(options.locationId))!.businessDate : await businessToday(businessId) };
    case "catalog": {
      const [prefs, locations, today] = await Promise.all([
        getSetting<{ currencyDisplay?: string }>(businessId, SETTING_KEYS.businessPrefs),
        query<{ id: string; name: string }>("SELECT id, name FROM locations WHERE business_id = $1 ORDER BY created_at", [businessId]),
        options.locationId ? getBusinessDayStatus(options.locationId).then((s) => s!.businessDate) : businessToday(businessId),
      ]);
      return {
        currencyDisplay: prefs?.currencyDisplay === "rial" ? "rial" as const : "toman" as const,
        apps, locations: locations.rows, today,
        reports: reports.map((report) => ({
          key: report.key, label: report.label, description: report.description ?? null,
          group: report.group, groupLabel: REPORT_GROUP_LABELS[report.group], shape: reportShape(report),
          chartType: report.defaultChart?.chartType ?? null, config: report.defaultChart?.config ?? null,
          money: reportConfigIsMoney(report.defaultChart?.config),
          hasDateColumn: Boolean(report.view && REPORT_VIEWS[report.view].dateColumn),
        })),
        views: accounting ? reportViewsFor(industry).map(({ key, view }) => ({
          key, label: view.label, hasDateColumn: !!view.dateColumn,
          dimensions: view.dimensions.map(({ key, label }) => ({ key, label })),
          metrics: view.metrics.map(({ key, label, money, aggregations }) => ({ key, label, money, aggregations })),
          filters: view.filters?.map(({ key, label }) => ({ key, label })) ?? [],
        })) : [],
      };
    }
    case "overview": {
      // Fixed small set, not an eager execution of the report catalog or remote services.
      const [sales, accountingPanel, activity] = await Promise.all([
        accounting ? panel(() => getBusinessOverview(businessId, options)) : null,
        // The platform console reads a tenant's books as the platform: an
        // operator either picked a branch (`options.locationId`) or is looking at
        // the whole business. Both are written out here rather than passed as an
        // optional id (issue #819).
        accounting
          ? panel(() =>
              getProfitAndLoss(
                businessId,
                options,
                options.locationId ? branchScope(options.locationId) : BUSINESS_WIDE_SCOPE,
              ),
            )
          : null,
        panel(() => businessUsage(businessId)),
      ]);
      return { sales, accounting: accountingPanel, activity };
    }
    case "branches":
      if (!accounting) break;
      return getBusinessOverview(businessId, options);
    case "crm":
      if (!apps.includes("crm")) break;
      // Authoritative CRM uses its rolling business-day window, not arbitrary range/branch filters.
      return crmOverview(businessId);
    case "growth": {
      if (!apps.includes("growth")) break;
      const overview = await growthOverview(businessId, { locationId: options.locationId ?? null, today: await businessToday(businessId) });
      // A redeemable gift-card code is a bearer secret, not a reporting label.
      return { ...overview, activity: overview.activity.map((row) => row.kind === "gift_card"
        ? { ...row, subject: "کارت هدیه" } : row) };
    }
    case "websites":
      if (!apps.includes("website")) break;
      return { wp: await panel(() => wpOverviewStats(businessId)) };
    case "cms": {
      if (!apps.includes("website")) break;
      // Separate lazy endpoint: remote availability cannot delay WP or local reports.
      const [managers, overview] = await Promise.all([
        panel(() => websiteManagersState(businessId)),
        panel(async () => {
          const result = await cmsWebsiteOverview(businessId);
          if (!result.ok) return { connected: false, error: result.error };
          const { site, pages, posts, products, orders, orderInbox } = result.data;
          // Explicit allowlist; never forward arbitrary CMS attributes, order PII or secrets.
          return {
            connected: true, error: null,
            site: { name: site.name, status: site.status, domain: site.domain, type: site.type, domainVerified: site.domainVerified ?? false },
            pages: pages.map(({ id, title, _status }) => ({ id, title, status: _status })),
            posts: posts.map(({ id, title, _status }) => ({ id, title, status: _status })),
            products: products.map(({ id, title }) => ({ id, title })),
            orders: orders.map(({ id }) => ({ id, status: orderInbox[id]?.status ?? null })),
          };
        }),
      ]);
      return { managers, overview };
    }
    case "health": {
      const [sync, backup, devices] = await Promise.all([
        panel(async () => {
          const s = await getSyncHealth(businessId);
          return { level: s.level, issues: s.issues, unsent: s.unsent, refused: s.refused,
            deferred: s.deferred, openDeadLetters: s.openDeadLetters, masterConflicts: s.masterConflicts,
            lastPushSuccessAt: s.lastPushSuccessAt, lastPullSuccessAt: s.lastPullSuccessAt,
            hasError: !!s.lastError, driftStatus: s.drift.status };
        }),
        panel(async () => {
          const b = await getBackupHealth(businessId);
          return { enabled: b.enabled, cloudEnabled: b.cloudEnabled, alert: b.alert,
            localLastSuccessAt: b.localLastSuccessAt, cloudLastSuccessAt: b.cloudLastSuccessAt,
            localFailed: !!b.localLastError, cloudFailed: !!b.cloudLastError };
        }),
        panel(async () => (await businessDesktopCompliance(businessId)).devices.map((d) => ({
          id: d.siteDeviceId, name: d.deviceName, location: d.locationName, status: d.deviceStatus,
          lastSeenAt: d.lastSeenAt, lastSuccessfulPushAt: d.lastSuccessfulPushAt,
          lastSuccessfulPullAt: d.lastSuccessfulPullAt, hasError: !!d.error,
          installedVersion: d.installedVersion, targetVersion: d.targetRelease?.version ?? null,
          minimumSupportedVersion: d.targetRelease?.minimumSupportedVersion ?? null,
          compliance: d.compliance, connectivity: d.connectivity, channel: d.channel,
          lastReportAt: d.lastReportAt,
        }))),
      ]);
      return { sync, backup, devices };
    }
  }
  throw new PlatformReportError("not_found", 404);
}

export async function platformStandardReport(context: Context, key: string) {
  const { businessId, industry, reports, options } = context;
  const def = reports.find((r) => r.key === key);
  if (!def) throw new PlatformReportError("not_found", 404);
  if (reportShape(def) === "rows" && def.defaultChart) {
    const config = def.defaultChart.config;
    const dated = REPORT_VIEWS[config.view].dateColumn;
    const current = { ...config, limit: Math.min(config.limit ?? 1000, 1000), filters: {
      ...config.filters, ...(dated ? { dateFrom: options.dateFrom, dateTo: options.dateTo } : {}),
    } };
    // The platform console chooses a branch explicitly (`options.locationId`,
    // parsed off its own wire with a strict schema) or reads the whole business
    // — an authorized operator asks for one or the other; there is no default
    // in between (issue #819).
    const rows = await runCustomReportQuery(businessId, current, platformScope(options.locationId));
    const previous = options.compare && dated && options.dateFrom && options.dateTo
      ? await runCustomReportQuery(businessId, { ...current, filters: {
        ...current.filters, ...previousPeriodRange(options.dateFrom, options.dateTo),
      } }, platformScope(options.locationId)) : null;
    return { rows, previous };
  }
  const shape = reportShape(def);
  if (!["rows", "profit_and_loss", "balance_sheet", "cash_flow", "food_cost_variance", "consignor_statements"].includes(shape) && !options.locationId)
    throw new PlatformReportError("location_required");
  const result = await runStandardReport(businessId, industry, def, {
    ...options,
    scope: platformScope(options.locationId),
    detailPage: options.page ?? 1,
  });
  if ("pagination" in result) return result;
  return result.report ? pageReportDetails(result.report as unknown as Record<string, unknown>, options.page) : result;
}

/**
 * The platform console's scope: a branch when the operator named one, the whole
 * business otherwise.
 *
 * Written as a function rather than an inline conditional so that "no branch"
 * is a *decision* a reader can see, matching the reporting surface's own rule
 * (issue #819) — the platform console is authorized by `platformCan(...)`, not
 * by a tenant branch assignment, so both forms are legitimate there.
 */
export function platformScope(locationId: string | undefined): ReportScope {
  return locationId ? branchScope(locationId) : BUSINESS_WIDE_SCOPE;
}

export async function platformCustomReport(context: Context, config: ReportConfig) {
  if (!context.accounting || !reportViewsFor(context.industry).some(({ key }) => key === config.view))
    throw new PlatformReportError("not_found", 404);
  return { rows: await runCustomReportQuery(context.businessId, config, platformScope(context.options.locationId)) };
}
