import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createCurrency,
  getBusinessCurrencyConfig,
  listCurrencies,
  MulticurrencyError,
} from "@/lib/multicurrency-service";

/**
 * The currency catalogue and this business's configuration, in one read.
 *
 * The catalogue is global reference data (ISO codes, precision, active flag);
 * the business config names the base currency and which transaction currencies
 * are switched on. Every multicurrency surface — settings, documents, reports —
 * starts from this route.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const [currencies, config] = await Promise.all([
    listCurrencies(true),
    getBusinessCurrencyConfig(session.businessId),
  ]);
  return NextResponse.json({ currencies, config });
});

/**
 * Adds a custom currency to the catalogue. PLATFORM-admin only: the catalogue
 * is one set of rows shared by every tenant on the install, so a tenant's
 * settings.manage must never be able to add, rename, re-scale or deactivate a
 * currency into anybody else's books. Tenants configure WHICH currencies they
 * use on /api/currencies/settings; the catalogue itself is provisioned here.
 * ISO-standard currencies ship seeded; this exists for the long tail.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = body as { code?: unknown; name?: unknown; symbol?: unknown; precision?: unknown };
  if (typeof input.precision !== "number") {
    return NextResponse.json({ error: "invalid_currency_precision" }, { status: 400 });
  }

  try {
    const currency = await createCurrency({
      code: String(input.code ?? ""),
      name: String(input.name ?? ""),
      symbol: typeof input.symbol === "string" ? input.symbol : undefined,
      precision: input.precision,
    });
    return NextResponse.json({ currency }, { status: 201 });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
