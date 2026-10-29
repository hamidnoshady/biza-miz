import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import {
  getStudioTour, listStudioTourRevisions, rollbackStudioTour, deleteDraftStudioTour, TourStudioError,
} from "@/lib/tour-catalogue-service";

type Ctx = { params: Promise<{ tourId: string }> };
export const GET = withPlatformScope(async (_request: NextRequest, context: Ctx) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const { tourId } = await context.params;
  const tour = await getStudioTour(tourId);
  if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ tour, revisions: await listStudioTourRevisions(tourId) });
});
/** A published tour must first be set to draft; deleting a live tour is not permitted. */
export const DELETE = withPlatformScope(async (_request: NextRequest, context: Ctx) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;
  const { tourId } = await context.params;
  try {
    await deleteDraftStudioTour(tourId);
    await platformAudit({ adminId: session.padmin, action: "knowledge_tour.delete",
      entity: "knowledge_tours", entityId: tourId, payload: {} });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TourStudioError)
      return NextResponse.json({ error: err.code }, { status: 409 });
    throw err;
  }
});
/** Restore an immutable revision by creating a *new* version, never rewriting history. */
export const POST = withPlatformScope(async (request: NextRequest, context: Ctx) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;
  const { tourId } = await context.params;
  const raw = await request.json().catch(() => null);
  if (!raw || !Number.isInteger(raw.version) || !Number.isInteger(raw.expectedVersion))
    return NextResponse.json({ error: "invalid_version" }, { status: 400 });
  try {
    const result = await rollbackStudioTour(tourId, raw.version, raw.expectedVersion, session.padmin);
    await platformAudit({ adminId: session.padmin, action: "knowledge_tour.rollback",
      entity: "knowledge_tours", entityId: tourId, payload: { restored: raw.version, next: result.version } });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof TourStudioError)
      return NextResponse.json({ error: err.code }, { status: err.code === "version_conflict" ? 409 : 400 });
    throw err;
  }
});
