import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import { createDesktopRelease, validateDesktopReleaseInput } from "@/lib/desktop-release-service";

function matchesToken(value: string, expected: string): boolean {
  const left = createHash("sha256").update(value).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Protected release-pipeline ingress. It registers immutable metadata only;
 * normal tenant users cannot call it and it never accepts storage credentials.
 */
export async function POST(request: NextRequest) {
  const configured = process.env.DESKTOP_RELEASE_PUBLISH_TOKEN?.trim() ?? "";
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!configured || !bearer || !matchesToken(bearer, configured)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const validated = validateDesktopReleaseInput(body);
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });
  // Promotion enters the registry paused/internal. An accountable console
  // operator deliberately advances pilot/percentage/full rollout afterward.
  validated.input.status = "published";
  validated.input.rolloutState = "internal";
  validated.input.rolloutPercentage = 0;
  try {
    const release = await createDesktopRelease(validated.input, null);
    await withoutTenantScope("platform", () => query(
      `INSERT INTO platform_audit_log (action,entity,entity_id,payload)
       VALUES ('desktop_release.pipeline_promote','platform_release',$1,$2)`,
      [release.id, JSON.stringify({
        version: release.version,
        channel: release.channel,
        buildCommit: release.buildCommit,
        installerSha256: release.installer.sha256,
        rolloutState: release.rolloutState,
      })],
    ));
    return NextResponse.json({ releaseId: release.id, version: release.version, channel: release.channel }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      return NextResponse.json({ error: "release_exists" }, { status: 409 });
    }
    throw error;
  }
}
