import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { validateReportConfigForIndustry, type ReportConfig } from "@/lib/reports";
import { branchScope, parseReportScope } from "@/lib/report-scope";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { runCustomReportQuery } from "@/lib/reports-service";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function configFromSearchParams(searchParams: URLSearchParams): ReportConfig & { limit: number } {
  const equals: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (key.startsWith("filter.")) equals[key.slice("filter.".length)] = value;
  }

  const dateFrom = searchParams.get("dateFrom") ?? undefined;
  const dateTo = searchParams.get("dateTo") ?? undefined;
  const filters =
    dateFrom || dateTo || Object.keys(equals).length > 0
      ? { dateFrom, dateTo, ...(Object.keys(equals).length > 0 ? { equals } : {}) }
      : undefined;

  const rawLimit = searchParams.get("limit");
  const hasSort = searchParams.has("sortBy") || searchParams.has("sortDir");
  return {
    view: searchParams.get("view") ?? "",
    metric: searchParams.get("metric") ?? "",
    aggregation: (searchParams.get("aggregation") ?? "") as ReportConfig["aggregation"],
    dimension: searchParams.get("dimension") ?? "",
    filters,
    sort: hasSort
      ? {
          by: searchParams.get("sortBy") === "metric" ? "metric" : "dimension",
          dir: searchParams.get("sortDir") === "desc" ? "desc" : "asc",
        }
      : undefined,
    limit: rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit),
  };
}

/**
 * Runs a whitelist-backed report query. Query-string filters use filter.<key>
 * and are validated against the same report-view catalogue as the dashboard.
 */
export const GET = withApiKeyScope(async (apiKey, request: NextRequest) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.reportsRead);
  if (denied) return denied;

  const searchParams = new URL(request.url).searchParams;
  const requestedScope = parseReportScope(searchParams.get("scope"));
  if (requestedScope === null) return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  if (requestedScope === "business-wide") {
    return NextResponse.json({ error: "scope_not_supported" }, { status: 400 });
  }
  if (typeof apiKey.locationId !== "string" || apiKey.locationId.trim() === "") {
    return NextResponse.json({ error: "no_accessible_branch" }, { status: 403 });
  }

  const config = configFromSearchParams(searchParams);
  if (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > MAX_LIMIT) {
    return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
  }

  const industry = await getBusinessIndustry(apiKey.businessId);
  const errors = validateReportConfigForIndustry(config, industry);
  if (errors.length > 0) {
    return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });
  }

  // The key's own live, business-bound location is this front door's scope.
  // Keys are branch-pinned; an absent location is refused above, never widened.
  const rows = await runCustomReportQuery(apiKey.businessId, config, branchScope(apiKey.locationId));
  return NextResponse.json({ rows });
});
