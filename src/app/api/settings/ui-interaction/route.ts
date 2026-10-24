import { NextRequest, NextResponse } from "next/server";
import { requireMember, requirePermission, withTenantScope } from "@/lib/auth";
import { query, withTenantTransaction } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import {
  DEFAULT_UI_INTERACTION_SETTINGS,
  normalizeUiInteractionSettings,
  parseUiInteractionSettings,
} from "@/lib/ui-interaction-settings";

export const dynamic = "force-dynamic";
const KEY = SETTING_KEYS.uiInteraction;

export const GET = withTenantScope(async () => {
  // Every active business member can read operational gesture defaults; only
  // settings managers can write them. This lets cashier devices apply policy.
  const { session, error } = await requireMember();
  if (error) return error;
  const raw = await getSetting<unknown>(session.businessId, KEY);
  return NextResponse.json({ settings: parseUiInteractionSettings(raw), defaultSettings: DEFAULT_UI_INTERACTION_SETTINGS });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "invalid_settings" }, { status: 400 });
  const raw = body as Record<string, unknown>;
  const reset = raw.resetToDefaults === true && Object.keys(raw).length === 1;
  const candidate = reset ? DEFAULT_UI_INTERACTION_SETTINGS : raw.settings;
  const settings = normalizeUiInteractionSettings(candidate);
  if (!settings || (!reset && Object.keys(raw).some((key) => key !== "settings"))) {
    return NextResponse.json({ error: "invalid_settings" }, { status: 400 });
  }
  try {
    await withTenantTransaction(session.businessId, async () => {
      const before = parseUiInteractionSettings(await getSetting<unknown>(session.businessId, KEY));
      await setSetting(session.businessId, KEY, settings);
      await query(
        `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
         VALUES ($1,$2,$3,'settings.ui_interaction.updated','settings',$4,$5::jsonb)`,
        [session.businessId, session.locationId, session.sub, KEY, JSON.stringify({ before, after: settings, resetToDefaults: reset })],
      );
    }, { locationId: session.locationId ?? undefined, userId: session.sub });
    return NextResponse.json({ ok: true, settings });
  } catch (caught) {
    console.error("ui interaction settings save failed:", caught);
    return NextResponse.json({ error: "settings_save_failed" }, { status: 500 });
  }
});
