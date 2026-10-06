import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createConnection, listConnections, type LinkMode } from "@/lib/integrations/connections-service";
import { createHolooConnection, type HolooWriteMode } from "@/lib/integrations/holoo/connection-service";
import type { HolooCurrencyUnit } from "@/lib/integrations/holoo/holoo-money";
import type { WooCurrencyUnit } from "@/lib/integrations/woo-money";

export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  const provider = new URL(request.url).searchParams.get("provider");
  const connections = await listConnections(session.businessId);
  const filtered = provider ? connections.filter((connection) => connection.provider === provider) : connections;
  return NextResponse.json({ connections: filtered });
});

interface CreateBody {
  name?: string;
  baseUrl?: string;
  /** "plugin" to connect through the WordPress plugin; anything else is the REST/consumer-key shape. */
  linkMode?: LinkMode;
  consumerKey?: string;
  consumerSecret?: string;
  wpUsername?: string;
  wpApplicationPassword?: string;
  currencyUnit?: WooCurrencyUnit;
  locationId?: string | null;
  syncOrders?: boolean;
  syncProducts?: boolean;
  syncCustomers?: boolean;
  pushStock?: boolean;
  pushPrices?: boolean;
  syncCategories?: boolean;
  autoPullOrders?: boolean;
  orderLookbackDays?: number;
  /** "holoo" creates a Holoo connection instead of a WooCommerce one. */
  provider?: string;
  // Holoo connection fields (used only when provider === "holoo").
  host?: string;
  port?: number;
  database?: string;
  sqlUser?: string;
  sqlPassword?: string;
  webServiceBaseUrl?: string | null;
  wsUser?: string;
  wsPassword?: string;
  writeMode?: HolooWriteMode;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.locationId && body.locationId !== location.id) {
    return NextResponse.json({ error: "location_mismatch" }, { status: 403 });
  }

  if (body.provider === "holoo") {
    const result = await createHolooConnection(session.businessId, session.sub, body.name ?? "", {
      host: body.host ?? "",
      port: typeof body.port === "number" ? body.port : 1433,
      database: body.database ?? "",
      sqlUser: body.sqlUser,
      sqlPassword: body.sqlPassword,
      webServiceBaseUrl: body.webServiceBaseUrl ?? null,
      wsUser: body.wsUser,
      wsPassword: body.wsPassword,
      currencyUnit: (body.currencyUnit as HolooCurrencyUnit) ?? "rial",
      writeMode: body.writeMode ?? "none",
      locationId: location.id,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ connectionId: result.connectionId, provider: "holoo" }, { status: 201 });
  }

  const result = await createConnection(session.businessId, session.sub, {
    name: body.name ?? "",
    baseUrl: body.baseUrl ?? "",
    linkMode: body.linkMode === "plugin" ? "plugin" : "rest_api",
    consumerKey: body.consumerKey ?? "",
    consumerSecret: body.consumerSecret ?? "",
    wpUsername: body.wpUsername,
    wpApplicationPassword: body.wpApplicationPassword,
    currencyUnit: body.currencyUnit ?? "toman",
    locationId: location.id,
    syncOrders: body.syncOrders,
    syncProducts: body.syncProducts,
    syncCustomers: body.syncCustomers,
    pushStock: body.pushStock,
    pushPrices: body.pushPrices,
    syncCategories: body.syncCategories,
    autoPullOrders: body.autoPullOrders,
    orderLookbackDays: body.orderLookbackDays,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Both secrets exist only in this response — the webhook secret the store
  // signs its deliveries with (REST mode) and the link token the plugin
  // authenticates with. Never cached, never retrievable afterwards.
  const response = NextResponse.json(
    { connection: result.connection, webhookSecret: result.webhookSecret, linkToken: result.linkToken ?? null },
    { status: 201 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});
