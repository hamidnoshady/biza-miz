import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { parseStudioTourInput } from "@/lib/tour-studio";
import { listStudioTours, saveStudioTour } from "@/lib/tour-studio-service";
import { studioError } from "./studio-error";

/**
 * The authored guided-tour catalogue (issue #972, migration 0288).
 *
 * GET lists every authored tour for the console's «تورهای تعاملی» tab; any
 * admin may read it (tours are published content for every business). POST
 * saves a working copy — a new tour, or the next revision of an existing one —
 * and needs `knowledge.manage`.
 *
 * Validation happens here, not in the browser: the payload's page must be in
 * the canonical registry, its route is read from that registry rather than
 * trusted, and every spotlight must name a registered anchor. `expectedVersion`
 * is the version the editor read, so two authors cannot silently overwrite each
 * other (a stale one is a 409).
 */
export const GET = withPlatformScope(async (_request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ tours: await listStudioTours() });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseStudioTourInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, detail: parsed.detail }, { status: 400 });
  }

  const raw = body as Record<string, unknown> | null;
  const expected = raw?.expectedVersion;
  const expectedVersion =
    typeof expected === "number" && Number.isInteger(expected) && expected >= 1 ? expected : null;

  try {
    const saved = await saveStudioTour(parsed.input, session.padmin, expectedVersion);
    await platformAudit({
      adminId: session.padmin,
      action: saved.created ? "knowledge_tour.create" : "knowledge_tour.save",
      entity: "knowledge_tours",
      entityId: saved.id,
      payload: { tourKey: parsed.input.tourKey, version: saved.version },
    });
    return NextResponse.json({ ok: true, id: saved.id, version: saved.version, created: saved.created });
  } catch (err) {
    return studioError(err);
  }
});
