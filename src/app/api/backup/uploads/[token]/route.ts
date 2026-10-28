import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { abandonUploadSession, appendUploadChunk, UPLOAD_MAX_CHUNK_BYTES } from "@/lib/tenant-backup-transport";

/**
 * Issue #903 §3 — one chunk (`PUT ?offset=<n>`) or abandonment (`DELETE`).
 *
 * The body is the raw piece. `offset` must equal what the server already holds:
 * a retried piece is rejected rather than duplicated, and a resumed upload names
 * exactly where it left off. Errors carry a code and nothing else — never a
 * path, an offset on disk or a provider message.
 */
export const PUT = withTenantScope(
  async (request: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
    if (error) return error;
    const { token } = await ctx.params;

    const offsetParam = request.nextUrl.searchParams.get("offset");
    if (offsetParam === null || !/^\d{1,12}$/.test(offsetParam)) {
      return NextResponse.json({ error: "invalid_offset" }, { status: 400 });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > UPLOAD_MAX_CHUNK_BYTES) {
      return NextResponse.json({ error: "chunk_too_large" }, { status: 413 });
    }
    const chunk = Buffer.from(new Uint8Array(await request.arrayBuffer()));
    if (chunk.length === 0) return NextResponse.json({ error: "empty_chunk" }, { status: 400 });

    const written = await appendUploadChunk({
      businessId: session.businessId,
      token,
      offset: Number(offsetParam),
      chunk,
    });
    if (!written.ok) {
      const status =
        written.error === "upload_not_found" ? 404 : written.error === "chunk_too_large" || written.error === "upload_too_large" ? 413 : 409;
      return NextResponse.json({ error: written.error }, { status });
    }
    return NextResponse.json({ ok: true, receivedBytes: written.receivedBytes });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.backupRestore);
    if (error) return error;
    const { token } = await ctx.params;
    const abandoned = await abandonUploadSession(session.businessId, token);
    if (!abandoned) return NextResponse.json({ error: "upload_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
