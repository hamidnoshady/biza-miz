import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { listWorkspaceProjects } from "@/lib/workspace";
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
 * The media list is here for the same reason and is the sharpest case:
 * the Media Library's own route is owner/manager-only because a file store is
 * back-office custody, but attaching an already-uploaded drawing to a task is
 * not. So this returns file names and ids only — no storage key, no signed
 * URL, no byte access. Uploading still goes through «رسانه» and its own gate.
 *
 * Scope (#761): the projects list is only the projects the caller can see —
 * the same rule as every list — and the people, parties and media pickers
 * exist only for a member who can write (`workspace.manage`). A read-only
 * member fills no form, so handing them every colleague's and customer's name
 * would be a directory leak, not a picker.
 */
export const GET = withTenantScope(async () => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  try {
    const pickers = owner.access?.canManage === true;
    const none = { rows: [] as never[] };
    const [members, parties, projects, media] = await Promise.all([
      pickers
        ? query<{ id: string; full_name: string; role: string }>(
            `SELECT id, full_name, role FROM users
              WHERE business_id = $1 AND is_active
              ORDER BY full_name`,
            [owner.businessId],
          )
        : none,
      pickers
        ? query<{ id: string; name: string }>(
            `SELECT id, name FROM parties
              WHERE business_id = $1 AND is_active AND merged_into_id IS NULL
              ORDER BY name
              LIMIT 500`,
            [owner.businessId],
          )
        : none,
      listWorkspaceProjects(owner, { status: "all", limit: 200 }),
      pickers
        ? query<{ id: string; file_name: string }>(
            `SELECT id, file_name FROM media_assets
              WHERE business_id = $1 AND kind IN ('document', 'image')
              ORDER BY created_at DESC
              LIMIT 200`,
            [owner.businessId],
          )
        : none,
    ]);
    return NextResponse.json({
      members: members.rows.map((r) => ({ id: r.id, fullName: r.full_name, role: r.role })),
      parties: parties.rows,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      media: media.rows.map((r) => ({ id: r.id, fileName: r.file_name })),
    });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
