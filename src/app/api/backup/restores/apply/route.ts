import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { previewOwnedRestore } from "@/lib/tenant-backup-artifacts-service";
import { applyTenantRestore, mapApplyError } from "@/lib/tenant-restore-apply";

/**
 * Issue #903 §4 — apply a central, tenant-only logical restore.
 *
 * The request carries **no facts the server must trust**: the artifact is
 * re-resolved from the opaque reference, the preview is recomputed here (the
 * client's copy is ignored), the deployment role/profile come from trusted
 * process state, and re-authentication is read from the session token. The body
 * supplies only the typed confirmation phrase the Owner was shown.
 *
 * Every refusal is a code with a status; internal error text never crosses the
 * boundary. A successful apply reports the journal id — the durable record of
 * what happened, which is what an operator reads afterwards.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
  if (error) return error;

  let body: { ref?: unknown; confirmation?: unknown; passphrase?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const ref = typeof body.ref === "string" ? body.ref : "";
  const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  if (!ref || ref.length > 128 || confirmation.length > 200) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const profile = (await readDeploymentProfile(session.businessId)).profile;
  const role = deploymentRole();

  // Recompute the preview: a client that never saw one cannot apply, and a
  // client that did cannot edit it.
  const previewed = await previewOwnedRestore(session.businessId, ref, {
    role,
    profile,
    actor: {
      canRestore: true,
      mfaSatisfied: session.mfaVerified === true,
      reauthenticatedAt:
        typeof session.recentAuthAt === "number" ? new Date(session.recentAuthAt * 1000).toISOString() : null,
    },
    actorUserId: session.sub,
  });
  if ("error" in previewed) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }

  const minutesSinceReauthentication =
    typeof session.recentAuthAt === "number"
      ? Math.max(0, Math.floor((Date.now() - session.recentAuthAt * 1000) / 60000))
      : null;

  // One open apply row per business, alongside the durable lock the engine takes.
  const { rows: jobRows } = await query<{ id: string }>(
    `INSERT INTO tenant_backup_restore_jobs
       (business_id, artifact_ref, mode, phase, blockers, preview, actor_user_id)
     VALUES ($1,$2,'apply','approved',$3::jsonb,$4::jsonb,$5)
     RETURNING id`,
    [
      session.businessId,
      ref,
      JSON.stringify(previewed.preview.blockers.map((blocker) => blocker.code)),
      JSON.stringify(previewed.preview),
      session.sub,
    ],
  ).catch(() => ({ rows: [] as { id: string }[] }));
  const jobId = jobRows[0]?.id ?? null;

  const outcome = await applyTenantRestore({
    businessId: session.businessId,
    ref,
    deployment: { role, profile },
    preview: previewed.preview,
    typedConfirmation: confirmation,
    minutesSinceReauthentication,
    legacyPassphrase: passphrase,
    actorId: session.sub,
    actorLabel: session.role,
  });

  if (jobId) {
    await query(
      `UPDATE tenant_backup_restore_jobs
          SET phase = $3,
              journal_id = $4,
              checkpoint_ref = $5,
              failure_code = $6,
              completed_at = CASE WHEN $3 IN ('succeeded','failed','rolled_back') THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        session.businessId,
        jobId,
        outcome.ok ? "succeeded" : "failed",
        outcome.journalId ?? null,
        outcome.ok ? outcome.checkpointFile : outcome.checkpointFile ?? null,
        outcome.ok ? null : outcome.error,
      ],
    ).catch(() => undefined);
  }

  if (!outcome.ok) {
    const error = mapApplyError(outcome.error);
    const status =
      error === "restore_busy"
        ? 409
        : error === "artifact_not_found" || error === "artifact_not_owned_by_business"
          ? 404
          : error === "confirmation_required" || error === "reauthentication_required" || error === "backup_restore_not_permitted"
            ? 403
            : 422;
    return NextResponse.json({ error, journalId: outcome.journalId ?? null }, { status });
  }

  return NextResponse.json(
    {
      ok: true,
      journalId: outcome.journalId,
      tables: outcome.tables,
      inserted: outcome.inserted,
      deleted: outcome.deleted,
      verified: outcome.verified,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
