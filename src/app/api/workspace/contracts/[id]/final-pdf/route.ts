import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { generateOrReadFinalContractPdf } from "@/lib/contracts/final-pdf";
import { requireContract } from "@/lib/contracts/service";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { handleWorkspaceError, PERMISSIONS, workspaceOwner } from "../../../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create once, then download the immutable Media Library artifact for the latest completed version. */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      const contract = await requireContract(owner, id);
      const finalPdf = await generateOrReadFinalContractPdf(owner, contract, request.url, request.headers);
      const safeName = encodeURIComponent(finalPdf.fileName);
      return new NextResponse(new Uint8Array(finalPdf.bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(finalPdf.bytes.byteLength),
          "Content-Disposition": `attachment; filename*=UTF-8''${safeName}`,
          "Cache-Control": "no-store, private",
          "X-Content-Type-Options": "nosniff",
          "X-Contract-Version": String(finalPdf.version),
          "X-Contract-Content-SHA256": finalPdf.contentHash,
          "X-Contract-PDF-SHA256": finalPdf.pdfSha256,
        },
      });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
