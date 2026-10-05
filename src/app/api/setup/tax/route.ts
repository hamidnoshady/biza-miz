import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getSetting, markStepDone, setSetting, SETTING_KEYS } from "@/lib/settings";
import { requireManager, type TaxSetting } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/**
 * Tax. A default VAT rate (percent) is stored business-wide and
 * stamped onto new menu categories; per-category overrides handle exemptions.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const tax = await getSetting<TaxSetting>(session.businessId, SETTING_KEYS.tax);
  const { rows: categories } = await query(
    `SELECT mc.id, mc.name, mc.tax_rate
       FROM menu_categories mc JOIN locations l ON l.id = mc.location_id
      WHERE l.business_id = $1 ORDER BY mc.sort_order, mc.name`,
    [session.businessId],
  );
  return NextResponse.json({ tax, categories });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { defaultRate?: number; categories?: { id: string; taxRate: number }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const defaultRate = Number(body.defaultRate);
  if (!Number.isFinite(defaultRate) || defaultRate < 0 || defaultRate > 100) {
    return NextResponse.json({ error: "invalid_rate" }, { status: 400 });
  }

  for (const c of body.categories ?? []) {
    const rate = Number(c.taxRate);
    if (!c.id || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json({ error: "invalid_category_rate" }, { status: 400 });
    }
  }

  const setting: TaxSetting = { defaultRate };
  await setSetting(session.businessId, SETTING_KEYS.tax, setting);

  for (const c of body.categories ?? []) {
    await query(
      `UPDATE menu_categories mc SET tax_rate = $1
        FROM locations l
       WHERE mc.id = $2 AND l.id = mc.location_id AND l.business_id = $3`,
      [c.taxRate, c.id, session.businessId],
    );
  }

  const progress = await markStepDone(session.businessId, "tax");
  return NextResponse.json({ ok: true, progress });
});
