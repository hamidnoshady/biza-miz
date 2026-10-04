import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { markStepDone, setSetting, SETTING_KEYS } from "@/lib/settings";
import { resolveActiveLocation, requireManager, type BusinessPrefs } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/** Business info: names, contact, display/currency preferences. (First in every industry shape.) */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: {
    businessName?: string;
    locationName?: string;
    address?: string;
    phone?: string;
    currencyDisplay?: "toman" | "rial";
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessName = body.businessName?.trim();
  const locationName = body.locationName?.trim();
  if (!businessName || !locationName) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const currencyDisplay = body.currencyDisplay === "rial" ? "rial" : "toman";

  await query("UPDATE businesses SET name = $1 WHERE id = $2", [businessName, session.businessId]);

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location" }, { status: 409 });
  }
  await query("UPDATE locations SET name = $1, address = $2, phone = $3 WHERE id = $4", [
    locationName,
    body.address?.trim() || null,
    body.phone?.trim() || null,
    location.id,
  ]);

  const prefs: BusinessPrefs = { currencyDisplay, language: "fa", calendar: "jalali" };
  await setSetting(session.businessId, SETTING_KEYS.businessPrefs, prefs);
  const progress = await markStepDone(session.businessId, "business");

  return NextResponse.json({ ok: true, progress });
});
