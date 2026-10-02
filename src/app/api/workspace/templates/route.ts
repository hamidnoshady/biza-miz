import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { readAecOperatingProfile } from "@/lib/aec-service";
import { archiveTemplate, listTemplates, saveTemplate } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * Project blueprints. The GET returns the built-in catalogue (code, so every
 * tenant has it without seeding) merged with the business's own rows, scoped to
 * the business's industry — issue #799 §4's six AEC blueprints are only offered
 * to an AEC tenant — and ordered with the ones recommended for its operating
 * profile first, each carrying a `recommended` flag.
 *
 * Reconfiguring templates is structural — it reshapes every project created
 * afterwards — so the write sits on `workspace.manage`.
 */

/**
 * The list every response returns, resolved the same way: the industry scopes
 * which blueprints exist for this tenant, the operating profile decides the
 * «پیشنهادی» ordering. Read here rather than in the service because a *write*
 * must answer with the same shape it just changed.
 */
async function templateChoices(businessId: string) {
  const profile = await readAecOperatingProfile(businessId);
  return listTemplates(businessId, { profile });
}

export const GET = withTenantScope(async () => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  try {
    return NextResponse.json({ templates: await templateChoices(owner.businessId) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    await saveTemplate(owner, body);
    return NextResponse.json({ templates: await templateChoices(owner.businessId) }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  try {
    // Archives the business's own row. A built-in cannot be archived — it is
    // code, shared by every tenant, and hiding it for one would mean a
    // per-tenant exclusion table for no gain.
    await archiveTemplate(owner.businessId, key);
    return NextResponse.json({ templates: await templateChoices(owner.businessId) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
