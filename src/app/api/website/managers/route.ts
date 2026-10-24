import { NextResponse } from "next/server";
import { withTenantScope, requireAnyPermission } from "@/lib/auth";
import { WEBSITE_MANAGERS_READ_PERMISSIONS } from "@/lib/wp-access";
import { websiteManagersState } from "@/lib/website/managers-service";

/**
 * `GET /api/website/managers` — which of «مدیریت وب‌سایت»'s two managers this
 * business actually has.
 *
 * The app's sidebar and its home both build themselves from this: a manager
 * with no connection lists only the screens that can change that. Observed
 * state, two local reads, and no call to either external system — a down CMS
 * must not empty the app's own menu.
 */
export const GET = withTenantScope(async () => {
  // The same three keys that open the app (`canOpenWebsiteApp`); asking for
  // `website.view` alone emptied the sidebar for a member who held only the
  // WooCommerce or CMS key (#944 / OVR-01).
  const { session, error } = await requireAnyPermission(...WEBSITE_MANAGERS_READ_PERMISSIONS);
  if (error) return error;
  const managers = await websiteManagersState(session.businessId);
  const response = NextResponse.json({ managers });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
