import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MulticurrencyError, updateCurrency } from "@/lib/multicurrency-service";

interface Ctx {
  params: Promise<{ code: string }>;
}

/**
 * Edits a catalogue currency's display fields or active flag.
 *
 * Deliberately narrow: `precision` is refused once the currency has any
 * posting or rate (the service checks), because re-scaling a stored amount's
 * unit retroactively is exactly the kind of history rewrite multicurrency
 * exists to make impossible. Deactivating a currency never hides its history —
 * it only stops new documents and rates.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const { code } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const patch = body as { name?: unknown; symbol?: unknown; precision?: unknown; isActive?: unknown };

  try {
    const currency = await updateCurrency(code.toUpperCase(), {
      name: typeof patch.name === "string" ? patch.name : undefined,
      symbol: typeof patch.symbol === "string" ? patch.symbol : undefined,
      precision: typeof patch.precision === "number" ? patch.precision : undefined,
      isActive: typeof patch.isActive === "boolean" ? patch.isActive : undefined,
    });
    return NextResponse.json({ currency });
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
