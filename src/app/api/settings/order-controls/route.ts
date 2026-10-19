import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query, withTenantTransaction } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  DEFAULT_ORDER_CONTROL_POLICY,
  normalizeOrderControlPolicy,
  parseOrderControlPolicy,
} from "@/lib/order-controls";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Effective cashier/manager approval policy, plus the business fallback. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query<{ location_id: string | null; value: unknown }>(
    `SELECT location_id, value FROM settings
      WHERE business_id=$1 AND key='orders.controls'
        AND (location_id=$2 OR location_id IS NULL)
      ORDER BY (location_id=$2) DESC`,
    [session.businessId, location.id],
  );
  const branchSetting = rows.find((row) => row.location_id === location.id);
  const businessSetting = rows.find((row) => row.location_id === null);
  const businessPolicy = parseOrderControlPolicy(businessSetting?.value);
  return NextResponse.json({
    policy: branchSetting ? parseOrderControlPolicy(branchSetting.value) : businessPolicy,
    businessPolicy,
    hasBranchOverride: Boolean(branchSetting),
    defaultPolicy: DEFAULT_ORDER_CONTROL_POLICY,
    locationName: location.name,
  });
});

/** Save a branch override or remove it to inherit the business-wide policy. */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRecord(raw)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const inherit = raw.inheritBusinessDefault;
  if (inherit !== undefined) {
    if (inherit !== true || Object.keys(raw).length !== 1) {
      return NextResponse.json({ error: "invalid_order_control_policy" }, { status: 400 });
    }
  } else {
    const allowed = new Set([
      "cashierDiscountLimitPercent",
      "wholeOrderVoidRequiresManager",
      "postKitchenChangeRequiresManager",
    ]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) {
      return NextResponse.json({ error: "invalid_order_control_policy" }, { status: 400 });
    }
    if (!normalizeOrderControlPolicy(raw)) {
      return NextResponse.json({ error: "invalid_order_control_policy" }, { status: 400 });
    }
  }

  try {
    const result = await withTenantTransaction(
      session.businessId,
      async () => {
        // Serialize writes for this branch even when no branch override row
        // exists yet; locking only settings rows would leave the first insert
        // racing another first insert.
        await query(
          "SELECT id FROM locations WHERE id=$1 AND business_id=$2 FOR UPDATE",
          [location.id, session.businessId],
        );
        const { rows: beforeRows } = await query<{ location_id: string | null; value: unknown }>(
          `SELECT location_id, value FROM settings
            WHERE business_id=$1 AND key='orders.controls'
              AND (location_id=$2 OR location_id IS NULL)
            ORDER BY (location_id=$2) DESC FOR UPDATE`,
          [session.businessId, location.id],
        );
        const branchSetting = beforeRows.find((row) => row.location_id === location.id);
        const businessSetting = beforeRows.find((row) => row.location_id === null);
        const beforePolicy = branchSetting
          ? parseOrderControlPolicy(branchSetting.value)
          : parseOrderControlPolicy(businessSetting?.value);

        if (inherit) {
          await query(
            `DELETE FROM settings
              WHERE business_id=$1 AND location_id=$2 AND key='orders.controls'`,
            [session.businessId, location.id],
          );
        } else {
          const policy = normalizeOrderControlPolicy(raw)!;
          await query(
            `INSERT INTO settings (business_id, location_id, key, value)
             VALUES ($1, $2, 'orders.controls', $3::jsonb)
             ON CONFLICT (business_id, location_id, key)
             DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
            [session.businessId, location.id, JSON.stringify(policy)],
          );
        }

        const afterPolicy = inherit
          ? parseOrderControlPolicy(businessSetting?.value)
          : normalizeOrderControlPolicy(raw)!;
        await query(
          `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
           VALUES ($1, $2, $3, 'settings.order_controls.updated', 'settings', 'orders.controls', $4::jsonb)`,
          [session.businessId, location.id, session.sub, JSON.stringify({
            beforePolicy,
            afterPolicy,
            resetToBusinessDefault: inherit,
          })],
        );
        return { policy: afterPolicy, hasBranchOverride: !inherit };
      },
      { locationId: location.id, userId: session.sub },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (caught) {
    console.error("order control settings save failed:", caught);
    return NextResponse.json({ error: "order_control_settings_save_failed" }, { status: 500 });
  }
});
