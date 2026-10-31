import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBackupConfig } from "@/lib/backup-service";
import {
  DOWNLOAD_TICKET_TTL_SECONDS,
  openDownloadTicket,
  planArtifactDownload,
  sealDownloadTicket,
} from "@/lib/tenant-backup-transport";

/**
 * Issue #903 §3 — server-authorised artifact download, in two steps.
 *
 * `POST` mints a ticket: it is the step that checks the permission
 * (`backup.export`, Owner-only), resolves the opaque reference against *this*
 * business and refuses an artifact that is not `ready`. `GET` redeems it. The
 * split is deliberate — a ticket is short-lived and single-use in intent, and a
 * plain link (or a browser retry) can never carry a session cookie's authority
 * into a long download that outlives the session.
 *
 * The body is never JSON with a URL: for a cloud artifact the answer is a
 * time-limited redirect, and for a local artifact the bytes stream.
 */
export const POST = withTenantScope(
  async (_request: NextRequest, ctx: { params: Promise<{ ref: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.backupExport);
    if (error) return error;
    const { ref } = await ctx.params;

    const profile = (await readDeploymentProfile(session.businessId)).profile;
    const role = deploymentRole();
    const config = await getBackupConfig(session.businessId);

    // Pick the destination that actually holds the artifact. The caller names a
    // reference, not a destination.
    let destination: "local" | "cloud" | null = null;
    for (const candidate of ["local", "cloud"] as const) {
      const plan = await planArtifactDownload({
        businessId: session.businessId,
        ref,
        destination: candidate,
        profile,
        role,
        directory: config.directory,
      });
      if (plan.kind !== "error") {
        destination = candidate;
        break;
      }
    }
    if (!destination) return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });

    const ticket = sealDownloadTicket({
      businessId: session.businessId,
      ref,
      destination,
      expiresAt: Math.floor(Date.now() / 1000) + DOWNLOAD_TICKET_TTL_SECONDS,
    });
    if (!ticket) return NextResponse.json({ error: "backup_encryption_unconfigured" }, { status: 503 });

    return NextResponse.json(
      { ticket, expiresIn: DOWNLOAD_TICKET_TTL_SECONDS, destination },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);

export const GET = withTenantScope(
  async (request: NextRequest, ctx: { params: Promise<{ ref: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.backupExport);
    if (error) return error;
    const { ref } = await ctx.params;

    const opened = openDownloadTicket(request.nextUrl.searchParams.get("ticket"));
    if (!opened.ok) return NextResponse.json({ error: opened.error }, { status: 403 });
    // A ticket for another business or another artifact is not a ticket here.
    if (opened.claims.businessId !== session.businessId || opened.claims.ref !== ref) {
      return NextResponse.json({ error: "invalid_download_ticket" }, { status: 403 });
    }

    const profile = (await readDeploymentProfile(session.businessId)).profile;
    const config = await getBackupConfig(session.businessId);
    const plan = await planArtifactDownload({
      businessId: session.businessId,
      ref,
      destination: opened.claims.destination,
      profile,
      role: deploymentRole(),
      directory: config.directory,
    });
    if (plan.kind === "error") {
      const status = plan.error === "artifact_not_found" ? 404 : plan.error === "artifact_not_ready" ? 409 : 503;
      return NextResponse.json({ error: plan.error }, { status });
    }
    if (plan.kind === "redirect") {
      return NextResponse.redirect(plan.url, {
        status: 302,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const stream = createReadStream(plan.path);
    return new NextResponse(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(plan.sizeBytes),
        // The artifact is ciphertext; the header says which key opens it, which
        // is the same fact the inventory shows. It is not a secret.
        "X-Backup-Encryption": plan.encryption,
        "Content-Disposition": `attachment; filename="${ref.slice(0, 16)}.backup.enc"`,
        "Cache-Control": "no-store",
      },
    });
  },
);
