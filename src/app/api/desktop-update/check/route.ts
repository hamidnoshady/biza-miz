import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { checkDesktopUpdateNow, getDesktopUpdatePolicy } from "@/lib/app-update";
import { getServerSyncConfig } from "@/lib/server-sync";

/**
 * Issue #1008 — the explicit "ask Central now" step behind the settings
 * button.
 *
 * `GET /api/desktop-update/status` only reports what the 30-second sync tick
 * already fetched, and `bridge.check(targetRelease)` in the renderer can only
 * evaluate that cached value (a null target means «no update» without a single
 * network call). This endpoint runs the same authenticated runtime-status
 * exchange as the tick — immediately, outside the interval — and hands the
 * fresh target back for the Electron engine to validate.
 *
 * Reachability is reported as data (200 with `offline`/`error`), not as an
 * HTTP failure: the screen has to tell «no internet» from «Central said no
 * update», and a 5xx would collapse both into a generic error.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  try {
    const config = await getServerSyncConfig(session.businessId);
    const check = await checkDesktopUpdateNow(session.businessId, config);
    const policy = await getDesktopUpdatePolicy(session.businessId);
    return NextResponse.json({ ...check, policy });
  } catch {
    // A local failure (settings/DB) is not an answer from Central and must not
    // be presented as one.
    return NextResponse.json({ error: "update_check_failed" }, { status: 500 });
  }
});
