import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { simulateSavedCampaign } from "@/lib/campaign-builder-service";
import { campaignBuilderErrorResponse } from "@/lib/campaign-builder-http";

/**
 * The dry run: replays the last `windowDays` of this business's sales through
 * the campaign and answers what it would have reserved.
 *
 * A POST despite being a read, like the audience preview: it is composing a
 * campaign, and it returns revenue-derived figures, so it asks for
 * `campaigns.manage` rather than the list's `campaigns.view`. It writes
 * nothing — no reward, no liability, no journal entry.
 */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;
  const { id } = await context.params;

  // An empty body means "the default window"; a body that is present must be an object.
  const raw = await request.text();
  let windowDays: number | undefined;
  if (raw.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const requested = (body as { windowDays?: unknown }).windowDays;
    if (requested !== undefined) {
      if (typeof requested !== "number") return NextResponse.json({ error: "window_invalid" }, { status: 400 });
      windowDays = requested;
    }
  }

  try {
    return NextResponse.json({ simulation: await simulateSavedCampaign(session.businessId, id, { windowDays }) });
  } catch (e) {
    return campaignBuilderErrorResponse(e);
  }
});
