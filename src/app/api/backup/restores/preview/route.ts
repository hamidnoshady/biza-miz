import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { previewOwnedRestore } from "@/lib/tenant-backup-artifacts-service";

/**
 * Issue #903 §4 — the dry-run restore preview.
 *
 * This route **computes and journals** a preview. It does not restore anything:
 * the apply step (checkpoint, durable per-business lock, write pause,
 * transactional tenant-only replacement, verification and rollback) is a
 * separate engine and is not exposed here — deliberately, because a half-built
 * apply path is exactly the "tenant restore that quietly replaces more than one
 * business" failure the architecture forbids.
 *
 * Everything it needs is server-derived: the artifact is re-resolved against
 * this business's own inventory from the opaque reference, the manifest is
 * re-validated and its signature re-verified with the platform key, the
 * deployment role/profile come from trusted process state, and the actor's MFA
 * and re-authentication facts come from the session token — never from the body.
 *
 * Owner-only (`backup.restore`) even for the preview: what a restore would
 * overwrite is itself sensitive, and a Manager who cannot restore does not need
 * it.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;

  let body: { ref?: unknown };
  try {
    body = (await request.json()) as { ref?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.ref !== "string" || body.ref.length === 0 || body.ref.length > 128) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const profile = (await readDeploymentProfile(session.businessId)).profile;
  const result = await previewOwnedRestore(session.businessId, body.ref, {
    role: deploymentRole(),
    profile,
    actor: {
      // The permission check above is the authorization; this flag records it.
      canRestore: true,
      mfaSatisfied: session.mfaVerified === true,
      reauthenticatedAt:
        typeof session.recentAuthAt === "number"
          ? new Date(session.recentAuthAt * 1000).toISOString()
          : null,
    },
    actorUserId: session.sub,
  });

  if ("error" in result) {
    // An unknown or foreign reference is indistinguishable from a missing one.
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      preview: result.preview,
      jobId: result.jobId,
      // The apply path is not part of this release; the preview says so by
      // omitting any "applied" affordance, and this flag keeps a caller from
      // inventing one.
      applyAvailable: false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
