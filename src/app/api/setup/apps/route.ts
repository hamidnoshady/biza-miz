import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { isAppKey, type AppKey } from "@/lib/apps";
import { requireManager } from "@/lib/setup-state";
import {
  getSetupAppCatalog,
  saveSelectedSetupApps,
} from "@/lib/setup-apps-service";

/**
 * The onboarding gallery's data and its one write (issue #1239 / ESH-90).
 *
 * GET  — eligible apps, published prices, wallet balance, activation state.
 * PUT  — save the owner's *draft* selection.
 *
 * PUT deliberately has no billing branch. Selecting an app never calls the
 * activation endpoint, never opens an enabled interval and never debits the
 * wallet; a selected app stays `pending payment` until Finish and an explicit
 * post-wallet activation.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;
  return NextResponse.json(await getSetupAppCatalog(session.businessId));
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { apps?: unknown };
  try {
    body = (await request.json()) as { apps?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!Array.isArray(body.apps)) {
    return NextResponse.json({ error: "invalid_app" }, { status: 400 });
  }
  if (body.apps.some((key) => typeof key !== "string" || !isAppKey(key))) {
    return NextResponse.json({ error: "invalid_app" }, { status: 400 });
  }
  const apps = [...new Set(body.apps as AppKey[])];

  const saved = await saveSelectedSetupApps(session.businessId, apps);
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 400 });
  }

  return NextResponse.json(await getSetupAppCatalog(session.businessId));
});
