import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  listContracts,
  listDocuments,
  listWorkspaceProjects,
  listWorkspaceTasks,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../guard";

/**
 * GET ?q= — the command palette's search (Ctrl/Cmd+K).
 *
 * Deliberately NOT a search engine of its own: it calls the same
 * access-scoped list functions the sections use, so autocomplete can never
 * show a project, task, document or contract the member could not open from
 * its list (#761 — "never leak names through autocomplete").
 */
const PER_KIND = 6;

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ results: [] });
  try {
    const [projects, tasks, documents, contracts] = await Promise.all([
      listWorkspaceProjects(owner, { search: q, status: "all", limit: PER_KIND }),
      listWorkspaceTasks(owner, { search: q, status: "all", limit: PER_KIND }),
      listDocuments(owner, { search: q, limit: PER_KIND }),
      listContracts(owner, { search: q, status: "all", limit: PER_KIND }),
    ]);
    return NextResponse.json({
      results: [
        ...projects.map((p) => ({ kind: "project", id: p.id, title: p.name, subtitle: p.partyName })),
        ...tasks.map((t) => ({ kind: "task", id: t.id, title: t.title, subtitle: t.projectName })),
        ...documents.map((d) => ({ kind: "document", id: d.id, title: d.title, subtitle: d.projectName })),
        ...contracts.map((c) => ({ kind: "contract", id: c.id, title: c.title, subtitle: c.partyName ?? c.projectName })),
      ],
    });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
