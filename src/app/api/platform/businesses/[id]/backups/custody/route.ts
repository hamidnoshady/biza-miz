import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { businessCustodySummary, rotateArtifactCustodyKey } from "@/lib/tenant-backup-artifacts-service";
import { tenantBackupArtifactRef } from "@/lib/tenant-backup-artifact-ref";
import {
  custodyCoverageReport,
  unlockLegacyArtifact,
} from "@/lib/tenant-backup-custody-ops";

/**
 * Issue #903 §8 — custody operations for one business, operator-facing.
 *
 * `GET` is the loss report: which generations this business's artifacts name,
 * which of them the platform can still unwrap, and how many artifacts need a
 * customer passphrase instead. It rides `tenant_backup.read` because it is
 * metadata. Every mutation is a different trust:
 *
 *   rotate  `tenant_backup.policy`  mint the next generation, retire the current
 *   unlock  `tenant_backup.verify`  re-encrypt a legacy artifact under managed
 *                                   custody once the Owner has supplied their
 *                                   passphrase
 *
 * The passphrase is used once and never stored or logged. Nothing here returns
 * a key, a wrapped secret or a recovery envelope (that is an explicit,
 * tenant-held artefact and belongs to a different flow).
 */
export const GET = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { error } = await requirePlatformCapability("tenant_backup.read");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const [summary, coverage] = await Promise.all([
      businessCustodySummary(id, { legacyArtifacts: true }),
      custodyCoverageReport(id, tenantBackupArtifactRef),
    ]);
    return NextResponse.json(
      { custody: summary, coverage },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);

export const POST = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let body: { action?: unknown; ref?: unknown; passphrase?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "rotate") {
      const { session, error } = await requirePlatformCapability("tenant_backup.policy");
      if (error) return error;
      const rotated = await rotateArtifactCustodyKey(id);
      if (!rotated.ok) return NextResponse.json({ error: rotated.error }, { status: 503 });
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "tenant_backup.custody.rotate",
        entity: "backup_key_versions",
        payload: { version: rotated.version },
      }).catch(() => undefined);
      return NextResponse.json({ ok: true, version: rotated.version });
    }

    if (action === "unlock") {
      const { session, error } = await requirePlatformCapability("tenant_backup.verify");
      if (error) return error;
      const ref = typeof body.ref === "string" ? body.ref : "";
      const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
      if (!ref) return NextResponse.json({ error: "bad_request" }, { status: 400 });

      const profile = (await readDeploymentProfile(id)).profile;
      const unlocked = await unlockLegacyArtifact({
        businessId: id,
        ref,
        passphrase,
        deployment: { role: deploymentRole(), profile },
        createdBy: null,
      });
      // The passphrase never reaches the audit payload; only the outcome does.
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "tenant_backup.custody.unlock",
        entity: "tenant_backup_artifacts",
        payload: { ok: unlocked.ok, error: unlocked.ok ? null : unlocked.error },
      }).catch(() => undefined);
      if (!unlocked.ok) {
        const status = unlocked.error === "artifact_not_found" ? 404 : unlocked.error === "passphrase_invalid" ? 422 : 400;
        return NextResponse.json({ error: unlocked.error }, { status });
      }
      return NextResponse.json({ ok: true, ref: unlocked.ref, keyVersion: unlocked.keyVersion });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  },
);
