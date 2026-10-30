import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { listStudioTours, saveStudioTour, TourStudioError } from "@/lib/tour-catalogue-service";
import { KNOWLEDGE_PAGES } from "@/lib/knowledge-base";
import { TOUR_ANCHORS } from "@/lib/tours";

/** Global tour catalogue, code fallback, and registered spotlight anchors. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const catalogue = await listStudioTours();
  return NextResponse.json({
    ...catalogue, pages: KNOWLEDGE_PAGES, anchors: Object.values(TOUR_ANCHORS),
  });
});
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;
  const raw = await request.json().catch(() => null);
  try {
    const result = await saveStudioTour(raw, session.padmin);
    await platformAudit({
      adminId: session.padmin, action: "knowledge_tour.save", entity: "knowledge_tours",
      entityId: result.id, payload: { version: result.version },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof TourStudioError)
      return NextResponse.json({ error: err.code }, { status: err.code === "version_conflict" ? 409 : 400 });
    throw err;
  }
});
