import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import {
  DEFAULT_APPROVAL_TTL_MINUTES,
  grantRestoreApproval,
  listRestoreApprovals,
  revokeRestoreApproval,
} from "@/lib/tenant-backup-approvals";
import { resolveOwnedArtifact } from "@/lib/tenant-backup-artifacts-service";

/**
 * Issue #903 §3 — "recovery approvals".
 *
 * A Superadmin grants consent for one artifact, for one window. The tenant apply
 * route refuses without a valid approval **only** when
 * `require_restore_approval` is on for that business, so this route exists to
 * serve a business that opted into the control — it is not a gate on everybody.
 *
 * Capability `tenant_backup.restore` (owner-level), the same one that authorises
 * a privileged restore: whoever may restore may also consent, and nobody else
 * may consent on their behalf.
 *
 * `POST` resolves the reference against the business first: an approval for an
 * artifact this business does not own would be consent for something that cannot
 * be restored anyway, and accepting one silently would make the console lie
 * about what has been approved.
 */
export const GET = withPlatformScope(
  async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { error } = await requirePlatformCapability("tenant_backup.restore");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json(
      { approvals: await listRestoreApprovals(id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);

export const POST = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.restore");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let body: { ref?: unknown; ttlMinutes?: unknown; note?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const ref = typeof body.ref === "string" ? body.ref : "";
    if (!ref || ref.length > 128) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 500)) {
      return NextResponse.json({ error: "invalid_note" }, { status: 400 });
    }

    // Consent for an artifact that is not this business's is not consent.
    const artifact = await resolveOwnedArtifact(id, ref);
    if (!artifact) return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });

    const approval = await grantRestoreApproval({
      businessId: id,
      artifactRef: ref,
      approvedBy: session.padmin,
      ttlMinutes:
        body.ttlMinutes === undefined ? DEFAULT_APPROVAL_TTL_MINUTES : Number(body.ttlMinutes),
      note: typeof body.note === "string" ? body.note : "",
    });

    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "tenant_backup.restore.approve",
      entity: "tenant_backup_restore_approvals",
      payload: { ref, approvalId: approval.id, expiresAt: approval.expiresAt },
    }).catch(() => undefined);

    return NextResponse.json({ ok: true, approval }, { headers: { "Cache-Control": "no-store" } });
  },
);

export const DELETE = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("tenant_backup.restore");
    if (error) return error;
    const { id } = await ctx.params;
    if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const approvalId = request.nextUrl.searchParams.get("approvalId") ?? "";
    if (!approvalId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    const revoked = await revokeRestoreApproval(id, approvalId);
    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "tenant_backup.restore.revoke",
      entity: "tenant_backup_restore_approvals",
      payload: { approvalId, revoked },
    }).catch(() => undefined);

    if (!revoked) {
      // Either it never existed, or it was already consumed by a restore that
      // happened — rewriting that history is not an option.
      return NextResponse.json({ error: "approval_not_revocable" }, { status: 409 });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  },
);
