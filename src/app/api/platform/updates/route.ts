import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  createDesktopRelease,
  desktopFleetCompliance,
  validateDesktopReleaseInput,
} from "@/lib/desktop-release-service";

/** Device-level fleet telemetry plus the central Desktop release catalogue. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json(await desktopFleetCompliance());
});

/** Owner-only release registration. Installer credentials never enter this model. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("updates.manage");
  if (error) return error;
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const validated = validateDesktopReleaseInput(body);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });
  try {
    const release = await createDesktopRelease(validated.input, session.padmin);
    await platformAudit({
      adminId: session.padmin,
      action: "desktop_release.create",
      entity: "platform_release",
      entityId: release.id,
      payload: {
        version: release.version,
        buildCommit: release.buildCommit,
        channel: release.channel,
        status: release.status,
        rolloutState: release.rolloutState,
        rolloutPercentage: release.rolloutPercentage,
        installerSha256: release.installer.sha256,
      },
    });
    return NextResponse.json({ release }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      return NextResponse.json({ error: "release_exists" }, { status: 409 });
    }
    throw error;
  }
});
