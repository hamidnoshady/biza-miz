import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { listAecParticipantRoleOptions, loadAecProjectCockpit } from "@/lib/aec-service";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../guard";

/**
 * The pickers every workspace form needs: the business's active members, its
 * parties, its live projects and the document files already in the Media
 * Library.
 *
 * Its own endpoint rather than reusing `/api/team` and `/api/parties` because
 * those two are gated on `team.manage` and `parties.view` — permissions an
 * editor on a construction project has no reason to hold. Naming the customer
 * a project is for must not require the right to edit the customer directory,
 * so this returns the minimum a picker needs (an id and a display name) behind
 * `workspace.view` and nothing more. No phone, no address, no financial block.
 *
 * Two industry-specific entries, both AEC-only and both behind this same
 * `workspace.view`: the professional roles a participant may be recorded under,
 * and the resolved capability list the project cockpit uses to decide which
 * sections exist (issue #799 §21). Neither may need `settings.manage` — a
 * project editor does not configure the business — and a business of another
 * industry simply does not get the fields. Answering here, rather than on a
 * `/api/aec` route that would refuse with `industry_mismatch`, is what keeps a
 * café's project page from showing an error banner for a request it had to
 * make.
 *
 * The media list is here for the same reason and is the sharpest case:
 * the Media Library's own route is owner/manager-only because a file store is
 * back-office custody, but attaching an already-uploaded drawing to a task is
 * not. So this returns file names and ids only — no storage key, no signed
 * URL, no byte access. Uploading still goes through «رسانه» and its own gate.
 */
export const GET = withTenantScope(async () => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  try {
    const [members, parties, projects, media, participantRoles] = await Promise.all([
      query<{ id: string; full_name: string; role: string }>(
        `SELECT id, full_name, role FROM users
          WHERE business_id = $1 AND is_active
          ORDER BY full_name`,
        [owner.businessId],
      ),
      query<{ id: string; name: string }>(
        `SELECT id, name FROM parties
          WHERE business_id = $1 AND is_active AND merged_into_id IS NULL
          ORDER BY name
          LIMIT 500`,
        [owner.businessId],
      ),
      query<{ id: string; name: string }>(
        `SELECT id, name FROM ai_projects
          WHERE business_id = $1 AND archived_at IS NULL
          ORDER BY created_at DESC`,
        [owner.businessId],
      ),
      query<{ id: string; file_name: string }>(
        `SELECT id, file_name FROM media_assets
          WHERE business_id = $1 AND kind IN ('document', 'image')
          ORDER BY created_at DESC
          LIMIT 200`,
        [owner.businessId],
      ),
      listAecParticipantRoleOptions(owner.businessId),
    ]);
    // One read, two answers: the role list and the capability list come from
    // the same resolved profile, so they can never disagree about which
    // sections exist. A non-AEC tenant gets neither field.
    const cockpit = await loadAecProjectCockpit(owner.businessId);
    return NextResponse.json({
      members: members.rows.map((r) => ({ id: r.id, fullName: r.full_name, role: r.role })),
      parties: parties.rows,
      projects: projects.rows,
      media: media.rows.map((r) => ({ id: r.id, fileName: r.file_name })),
      // Omitted entirely outside AEC rather than sent empty, so a picker can
      // tell "this industry has no such list" from "the list is empty".
      ...(participantRoles ? { participantRoles } : {}),
      ...(cockpit.aec ? { aecCapabilities: cockpit.capabilities } : {}),
    });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
