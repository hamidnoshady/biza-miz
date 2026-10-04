import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createDocument, listDocuments, documentListPage, type DocumentListFilter } from "@/lib/workspace";
import type { WorkspaceDocumentStatus } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, pageParams, workspaceOwner } from "../guard";

/**
 * The unified document register. The BYTES are the Media Library's
 * (`media_assets`, migration 0149) and are uploaded through `/api/media`; a
 * row here is the *document* — its title, its owners, its review state and its
 * version chain. Keeping the two apart is what lets one storage quota, one
 * delete path and one AI-labelling pipeline serve every document in the
 * product.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const filter: DocumentListFilter = {
    ...pageParams(params),
    projectId: params.get("projectId") ?? undefined,
    taskId: params.get("taskId") ?? undefined,
    contractId: params.get("contractId") ?? undefined,
    partyId: params.get("partyId") ?? undefined,
    status: (params.get("status") as WorkspaceDocumentStatus | "all") ?? undefined,
    search: params.get("q") ?? undefined,
    currentOnly: params.get("versions") !== "all",
  };
  try {
    const [documents, { page, summary }] = await Promise.all([
      listDocuments(owner, filter),
      documentListPage(owner, filter),
    ]);
    return NextResponse.json({ documents, page, summary });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    return NextResponse.json({ document: await createDocument(owner, body) }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
