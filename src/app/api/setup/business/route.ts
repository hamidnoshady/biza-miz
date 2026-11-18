import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getSetting, markStepDone, setSetting, SETTING_KEYS } from "@/lib/settings";
import {
  resolveActiveLocation,
  requireManager,
  type BusinessPrefs,
  type SetupBusinessProfile,
} from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

const MAX_NAME = 200;
const MAX_ADDRESS = 500;
const MAX_PHONE = 32;
const MAX_TAX_ID = 50;
const MAX_WEBSITE = 300;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Business info: names, contact, the optional operational profile and the
 * display/currency preference. (First in every industry shape.)
 *
 * Extended for issue #1239 / ESH-90 rather than a second profile form: the
 * industry is shown but never written here (it is chosen once at provisioning),
 * and the logo has its own canonical endpoint (`/api/settings/business/logo`).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: {
    businessName?: string;
    locationName?: string;
    address?: string;
    phone?: string;
    legalName?: string;
    taxId?: string;
    email?: string;
    website?: string;
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
  const address = text(body.address);
  const phone = text(body.phone);
  const legalName = text(body.legalName);
  const taxId = text(body.taxId);
  const email = text(body.email);
  const website = text(body.website);
  if (
    businessName.length > MAX_NAME ||
    locationName.length > MAX_NAME ||
    address.length > MAX_ADDRESS ||
    phone.length > MAX_PHONE ||
    legalName.length > MAX_NAME ||
    taxId.length > MAX_TAX_ID ||
    website.length > MAX_WEBSITE
  ) {
    return NextResponse.json({ error: "field_too_long" }, { status: 400 });
  }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const currencyDisplay = body.currencyDisplay === "rial" ? "rial" : "toman";

  await query("UPDATE businesses SET name = $1 WHERE id = $2", [businessName, session.businessId]);

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location" }, { status: 409 });
  }
  await query("UPDATE locations SET name = $1, address = $2, phone = $3 WHERE id = $4", [
    locationName,
    address || null,
    phone || null,
    location.id,
  ]);

  // Preserve profile fields this step does not edit (e.g. receiptFooter),
  // while making a cleared field genuinely cleared.
  const existingProfile = await getSetting<SetupBusinessProfile>(
    session.businessId,
    SETTING_KEYS.businessProfile,
  );
  const profile: SetupBusinessProfile = {
    ...(existingProfile ?? {}),
    legalName: legalName || undefined,
    taxId: taxId || undefined,
    email: email || undefined,
    website: website || undefined,
  };

  const prefs: BusinessPrefs = { currencyDisplay, language: "fa", calendar: "jalali" };
  await Promise.all([
    setSetting(session.businessId, SETTING_KEYS.businessPrefs, prefs),
    setSetting(session.businessId, SETTING_KEYS.businessProfile, profile),
  ]);
  const progress = await markStepDone(session.businessId, "business");

  return NextResponse.json({ ok: true, progress });
});
