import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import {
  resolveActiveLocation,
  requireManager,
  requireSetupStepForIndustry,
  syncMenuStepProgress,
  type TaxSetting,
} from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/**
 * The menu step. GET returns current categories + items for the wizard.
 *
 * The step's progress marker is derived from the branch's sellable data after
 * every write (`syncMenuStepProgress`): a category with no items does *not*
 * complete it (issue #808 §3), and the old category-only marker is corrected
 * rather than trusted.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;
  const stepError = await requireSetupStepForIndustry(session.businessId, "menu");
  if (stepError) return stepError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ categories: [], items: [] });

  const [{ rows: categories }, { rows: items }] = await Promise.all([
    query(
      `SELECT id, name, tax_rate, sort_order FROM menu_categories
        WHERE location_id = $1 ORDER BY sort_order, name`,
      [location.id],
    ),
    query(
      `SELECT id, category_id, name, price, sku, description FROM menu_items
        WHERE location_id = $1 ORDER BY sort_order, name`,
      [location.id],
    ),
  ]);
  return NextResponse.json({ categories, items });
});

/**
 * Manual entry: { addCategory: { name } } or
 * { addItem: { categoryId, name, price (Rial), description?, sku? } }.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;
  const stepError = await requireSetupStepForIndustry(session.businessId, "menu");
  if (stepError) return stepError;

  let body: {
    addCategory?: { name?: string };
    addItem?: { categoryId?: string; name?: string; price?: number; description?: string; sku?: string };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  if (body.addCategory) {
    const name = body.addCategory.name?.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const { rows: dup } = await query(
      "SELECT id FROM menu_categories WHERE location_id = $1 AND name = $2",
      [location.id, name],
    );
    if (dup.length > 0) {
      return NextResponse.json({ error: "category_exists" }, { status: 409 });
    }
    const tax = await getSetting<TaxSetting>(session.businessId, SETTING_KEYS.tax);
    const { rows } = await query(
      `INSERT INTO menu_categories (location_id, name, tax_rate,
              sort_order)
       SELECT $1, $2, $3, COALESCE(MAX(sort_order) + 1, 0)
         FROM menu_categories WHERE location_id = $1
       RETURNING id`,
      [location.id, name, tax?.defaultRate ?? 0],
    );
    const progress = await syncMenuStepProgress(session.businessId, location.id);
    return NextResponse.json({ ok: true, id: rows[0].id, progress });
  }

  if (body.addItem) {
    const { categoryId, description, sku } = body.addItem;
    const name = body.addItem.name?.trim();
    const price = Number(body.addItem.price);
    if (!categoryId || !name || !Number.isSafeInteger(price) || price < 0) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    const { rows: cat } = await query(
      "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
      [categoryId, location.id],
    );
    if (cat.length === 0) {
      return NextResponse.json({ error: "category_not_found" }, { status: 404 });
    }
    const { rows } = await query(
      `INSERT INTO menu_items (location_id, category_id, name, price, description, sku, sort_order)
       SELECT $1, $2, $3, $4, $5, $6, COALESCE(MAX(sort_order) + 1, 0)
         FROM menu_items WHERE location_id = $1 AND category_id = $2
       RETURNING id`,
      [location.id, categoryId, name, price, description?.trim() || null, sku?.trim() || null],
    );
    const progress = await syncMenuStepProgress(session.businessId, location.id);
    return NextResponse.json({ ok: true, id: rows[0].id, progress });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
