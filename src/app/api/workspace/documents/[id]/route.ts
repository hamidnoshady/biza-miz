import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteDocument,
  getDocument,
  listComments,
  listDocumentVersions,
  resolveWorkspaceSubject,
  updateDocument,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

/**
 * One document with its full revision chain and its comment thread.
 * Reading needs `view` on the document's project (or authorship of a
 * business-level document); amending or removing it needs `edit`.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "document", id, "view");
      const document = await getDocument(owner.businessId, id);
      if (!document) return NextResponse.json({ error: "document_not_found" }, { status: 404 });
      const [versions, comments] = await Promise.all([
        listDocumentVersions(owner.businessId, id),
        listComments(owner.businessId, "document", id),
      ]);
      return NextResponse.json({ document, versions, comments });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await resolveWorkspaceSubject(owner, "document", id, "edit");
      const document = await updateDocument(owner, id, body);
      if (!document) return NextResponse.json({ error: "document_not_found" }, { status: 404 });
      return NextResponse.json({ document });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      await resolveWorkspaceSubject(owner, "document", id, "edit");
      // Only the register row goes; the media asset it points at stays in the
      // library, where its own delete path and quota accounting live.
      return NextResponse.json({ deleted: await deleteDocument(owner.businessId, id) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
