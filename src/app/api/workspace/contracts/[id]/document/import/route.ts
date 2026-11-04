import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  CONTRACT_IMPORT_MAX_BYTES,
  importContractDocument,
  type ContractImportErrorCode,
} from "@/lib/contracts/import";
import { requireContract } from "@/lib/contracts/service";
import { resolveWorkspaceSubject } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../../../../guard";

/**
 * Issue #908 — import an existing Word or PDF document into the contract draft.
 *
 * Three deliberate decisions:
 *
 *  1. **This route does not write.** It returns blocks and warnings; the editor
 *     puts them in the canvas and the existing `PUT …/document` saves them with
 *     the revision it already holds. One write path means the optimistic-
 *     concurrency guarantee (409 `document_conflict`) cannot be bypassed by an
 *     import, and a sender who dislikes the result can undo it like any edit.
 *  2. **The file is not stored.** There is no media asset, no temp file and no
 *     second document store: the bytes are parsed and dropped. Archiving the
 *     upload would make import depend on object storage being configured —
 *     irrelevant to the task, and a reason for it to fail on a fresh install.
 *  3. **Every refusal is a 4xx with a sentence.** "Import produced nothing" must
 *     never come back as success: a scanned PDF, a corrupt `.docx` and an empty
 *     body each say what is wrong, because the alternative is a sender freezing
 *     and sending a blank contract.
 *
 * Permission and subject scope are the document PUT's, exactly: a member who
 * cannot edit this contract cannot replace its body through this door either.
 */

const ERROR_STATUS: Record<ContractImportErrorCode, number> = {
  // 413: the request is understood and refused for its size, which is what a
  // client can retry differently.
  file_too_large: 413,
  unsupported_format: 415,
  docx_unreadable: 422,
  pdf_unreadable: 422,
  pdf_no_text_layer: 422,
  empty_document: 422,
};

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceContractsManage, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "contract", id, "edit");
      await requireContract(owner, id);

      // Refuse on the declared length before parsing the multipart body: a
      // 200 MB upload should cost a header read, not an allocation.
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > CONTRACT_IMPORT_MAX_BYTES + 64 * 1024) {
        return NextResponse.json(
          {
            error: "file_too_large",
            message: `حجم فایل بیش از ${Math.round(CONTRACT_IMPORT_MAX_BYTES / (1024 * 1024))} مگابایت است.`,
          },
          { status: 413 },
        );
      }

      const form = await request.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: "unsupported_format", message: "فایلی برای درون‌ریزی ارسال نشده است." },
          { status: 400 },
        );
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importContractDocument({
        bytes,
        fileName: file.name,
        mimeType: file.type,
      });
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error, message: result.detail },
          { status: ERROR_STATUS[result.error] ?? 400 },
        );
      }
      return NextResponse.json({
        content: result.content,
        source: result.source,
        stats: result.stats,
        warnings: result.warnings,
      });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
