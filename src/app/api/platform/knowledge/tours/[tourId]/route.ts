import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import {
  archiveStudioTour,
  deleteStudioTourDraft,
  getStudioTour,
  listStudioTourRevisions,
  publishStudioTour,
  rollbackStudioTour,
} from "@/lib/tour-studio-service";
import { studioError } from "../studio-error";

/**
 * One authored tour: its working copy, its immutable revision history, and the
 * three lifecycle actions the console needs (issue #972).
 *
 *  - GET     the tour and its revisions (any admin);
 *  - POST    `{ action: "publish" | "rollback" | "archive", … }` — needs
 *            `knowledge.manage` and is audited;
 *  - DELETE  a tour that was never published; anything a member has seen is
 *            archived instead, so "what were they taught" stays answerable.
 *
 * Publishing is what makes a tour visible to members: drafts and archived tours
 * are invisible to the tenant routes, and a published tour is served from its
 * own immutable revision, so a later edit never rewrites what someone saw.
 */
export const GET = withPlatformScope(
  async (_request, context: { params: Promise<{ tourId: string }> }) => {
    const { error } = await requirePlatformAdmin();
    if (error) return error;

    const { tourId } = await context.params;
    const tour = await getStudioTour(tourId);
    if (!tour) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ tour, revisions: await listStudioTourRevisions(tourId) });
  },
);

export const POST = withPlatformScope(
  async (request: NextRequest, context: { params: Promise<{ tourId: string }> }) => {
    const { session, error } = await requirePlatformCapability("knowledge.manage");
    if (error) return error;

    const { tourId } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const action = raw?.action;

    try {
      if (action === "publish") {
        const expected = raw?.version;
        const tour = await publishStudioTour(
          tourId,
          session.padmin,
          typeof expected === "number" && Number.isInteger(expected) ? expected : null,
        );
        await audited(session.padmin, "knowledge_tour.publish", tour.id, {
          tourKey: tour.tourKey,
          version: tour.publishedVersion,
        });
        return NextResponse.json({ ok: true, tour });
      }
      if (action === "rollback") {
        const toVersion = raw?.toVersion;
        if (typeof toVersion !== "number" || !Number.isInteger(toVersion)) {
          return NextResponse.json({ error: "bad_request", detail: "toVersion is required" }, { status: 400 });
        }
        const tour = await rollbackStudioTour(tourId, toVersion, session.padmin);
        await audited(session.padmin, "knowledge_tour.rollback", tour.id, {
          tourKey: tour.tourKey,
          restoredFrom: toVersion,
          version: tour.publishedVersion,
        });
        return NextResponse.json({ ok: true, tour });
      }
      if (action === "archive") {
        const tour = await archiveStudioTour(tourId, session.padmin);
        await audited(session.padmin, "knowledge_tour.archive", tour.id, { tourKey: tour.tourKey });
        return NextResponse.json({ ok: true, tour });
      }
      return NextResponse.json({ error: "bad_request", detail: "unknown action" }, { status: 400 });
    } catch (err) {
      return studioError(err);
    }
  },
);

export const DELETE = withPlatformScope(
  async (_request, context: { params: Promise<{ tourId: string }> }) => {
    const { session, error } = await requirePlatformCapability("knowledge.manage");
    if (error) return error;

    const { tourId } = await context.params;
    try {
      await deleteStudioTourDraft(tourId);
      await audited(session.padmin, "knowledge_tour.delete_draft", tourId, {});
      return NextResponse.json({ ok: true });
    } catch (err) {
      return studioError(err);
    }
  },
);

async function audited(
  adminId: string,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await platformAudit({ adminId, action, entity: "knowledge_tours", entityId, payload });
}
