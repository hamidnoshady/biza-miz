import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { parseGrowthSettingsInput } from "@/lib/growth-settings";
import { getGrowthSettings, updateGrowthSettings } from "@/lib/growth-settings-service";
import { listPrograms } from "@/lib/loyalty-service";
import { getPublicMessageConfig } from "@/lib/messaging-billing";

/**
 * Growth's own settings (issue #764).
 *
 * `settings` is the Growth-wide configuration this page owns — the
 * attribution window and the 30-day discount budget (src/lib/growth-settings.ts).
 * `readiness` is deliberately not a second dashboard: it carries only the two
 * facts that block the app from working at all (no default loyalty program,
 * messaging not set up by the platform), each linked from the page to the
 * screen that fixes it. Counts and figures stay on the Growth dashboard.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.marketingConfigure);
  if (error) return error;

  const [settings, programs, messaging] = await Promise.all([
    getGrowthSettings(session.businessId),
    listPrograms(session.businessId),
    getPublicMessageConfig(),
  ]);

  return NextResponse.json({
    settings,
    readiness: {
      hasDefaultLoyaltyProgram: programs.some((program) => program.isDefault && program.isActive),
      messagingReady: messaging.enabled && messaging.configured,
    },
  });
});

/** Saves a partial update; keys the body does not name keep their stored value. */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.marketingConfigure);
  if (error) return error;

  const body = await request.json().catch(() => null);
  const parsed = parseGrowthSettingsInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "invalid_growth_settings", message: parsed.errors.join(" ") }, { status: 400 });
  }
  const settings = await updateGrowthSettings(session.businessId, parsed.value, session.sub);
  return NextResponse.json({ settings });
});
