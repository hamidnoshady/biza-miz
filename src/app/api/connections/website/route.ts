import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { connectWebsite, disconnectWebsite, getWebsiteConnection, getWebsiteConnectionRow, listWebsiteConnectionRows, summarize } from "@/lib/website/connection-service";
import { summarizeWebsiteQueue } from "@/lib/website/catalog-service";
import { WEBSITE_ADAPTER_KEYS } from "@/lib/website/adapter";
import { isUuid } from "@/lib/menu-validation";

/**
 * Phase 38 (issue #379) — the platform-site connection and the POS→site
 * sync settings, as seen by the «اتصال‌های فنی» hub's «سایت‌ساز بیزامیز» tab
 * and «مدیریت وب‌سایت»'s sync settings. Owner and manager, deliberately
 * ungated by any feature flag: the `integrations` flag is the WooCommerce
 * connection's paid lock, not this site's — the hub tab for this connection
 * carries no lock, so its APIs must answer for any owner or manager the
 * same way `/api/cms/website/*` does.
 *
 * GET returns the masked summary and the queue counts. The API key is never
 * in any response — `WebsiteConnectionSummary` has no field for it.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;

  const requested = request.nextUrl.searchParams.get("connectionId");
  if (requested && !isUuid(requested)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const connectionId = requested ?? undefined;
  if (connectionId && !(await getWebsiteConnectionRow(session.businessId, connectionId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const enabled = true;
  const [connection, connections, queue] = await Promise.all([
    connectionId ? getWebsiteConnectionRow(session.businessId, connectionId).then((row) => row ? summarize(row) : null) : getWebsiteConnection(session.businessId),
    listWebsiteConnectionRows(session.businessId),
    summarizeWebsiteQueue(session.businessId, connectionId),
  ]);
  const response = NextResponse.json({ enabled, connection, connections: connections.map(summarize), queue });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

interface ConnectBody {
  adapterKey?: unknown;
  baseUrl?: unknown;
  siteDomain?: unknown;
  apiKey?: unknown;
  siteCurrency?: unknown;
  keyName?: unknown;
}

/** Test-then-save. A failed test stores nothing and returns the adapter's error code. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  let body: ConnectBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const adapterKey = typeof body.adapterKey === "string" ? body.adapterKey : "payload";
  if (!(WEBSITE_ADAPTER_KEYS as readonly string[]).includes(adapterKey)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // The in-memory mock is a development seam: it stores no real credential
  // and talks to no site, so production never accepts it.
  if (adapterKey === "mock" && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await connectWebsite(session.businessId, {
    adapterKey: adapterKey as "payload" | "mock",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
    siteDomain: typeof body.siteDomain === "string" ? body.siteDomain : "",
    apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
    siteCurrency: body.siteCurrency === "IRR" ? "IRR" : "IRT",
    keyName: typeof body.keyName === "string" ? body.keyName : undefined,
  });

  if (!result.ok) {
    const status = result.error === "unreachable" ? 503 : result.error === "unauthorized" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ connection: result.connection, siteName: result.siteName });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

/** Remove this app's stored key. The site and its content stay. */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (connectionId && !isUuid(connectionId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await disconnectWebsite(session.businessId, connectionId ?? undefined);
  return NextResponse.json({ connection: null });
});
