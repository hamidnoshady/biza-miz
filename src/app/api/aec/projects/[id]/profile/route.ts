import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { loadProjectAecProfile, saveProjectAecProfile } from "@/lib/aec-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * One project's AEC profile: site, areas, the employer/consultant/contractor
 * parties, contract method, permits, planned vs actual dates and planned vs
 * reported progress.
 *
 * GET — the stored profile, or `profile: null` when the project has none yet
 *       (the normal first visit; the form creates the row on save).
 * PUT — create or replace it. A `{ patch: true }` body amends only the fields
 *       it names, which is what a later wave's inline cockpit edits need; the
 *       full form sends every field and clears what it leaves empty.
 *
 * Authorization is the two-layer rule from the workspace module: the platform
 * permission (`workspace.view` / `workspace.manage`) narrows to the area, and
 * `requireProjectCapability` narrows it to THIS project. Membership — not the
 * permission alone — is what grants the project, exactly as everywhere else in
 * the module (#761); `workspace.admin` remains the single business-wide
 * override, and it rides the project role resolver rather than a flag here.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ profile: await loadProjectAecProfile(owner.businessId, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    const partial = body.patch === true;
    delete body.patch;
    try {
      await requireProjectCapability(owner, id, "manage");
      return NextResponse.json({
        profile: await saveProjectAecProfile(owner, id, body, { partial }),
      });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
