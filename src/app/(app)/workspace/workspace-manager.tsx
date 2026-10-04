"use client";

/**
 * The content controller for My Workspace.
 *
 * The persistent Workspace navigation lives in the tenant shell while a member
 * is under `/workspace`. Keeping a second in-page rail here created a
 * sidebar-inside-sidebar experience on desktop and a second route chooser on
 * mobile. This component now owns only the permission-aware section content;
 * URLs and the shared contextual sidebar own movement between sections.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PERMISSIONS } from "@/lib/permissions";
import { useWorkspaceLookups } from "./use-workspace-lookups";
import { type WorkspaceIntent, type WorkspaceSection } from "./workspace-routes";
import { OverviewSection } from "./overview-section";
import { ProjectsSection } from "./projects-section";
import { TasksSection } from "./tasks-section";
import { CalendarSection } from "./calendar-section";
import { DocumentsSection } from "./documents-section";
import { ContractsSection } from "./contracts-section";
import { TeamsSection } from "./teams-section";
import { ApprovalsSection } from "./approvals-section";
import { ReportsSection } from "./reports-section";
import { TemplatesSection } from "./templates-section";

/**
 * No `currentUserId` prop: every "mine" filter in this module is answered on
 * the server from the session (`?mine=true` never carries a user id), because
 * a "whose?" question a client can rewrite is not a filter, it is a leak.
 */
export function WorkspaceManager({
  activeSection,
  permissions,
}: {
  activeSection: WorkspaceSection;
  permissions: readonly string[];
}) {
  const lookups = useWorkspaceLookups();
  // Shortcut links («وظایف من», «قراردادهای رو به انقضا») land here with their
  // filter in the URL; the section opens already filtered, and the same URL
  // restores the same view when shared or reloaded.
  const search = useSearchParams();
  const initialMine = search.get("mine") === "true";
  const expiring = Number(search.get("expiring"));
  const initialExpiring = Number.isInteger(expiring) && expiring > 0 && expiring <= 365 ? expiring : undefined;
  // One-shot intents — «+ ایجاد» (`?create=1&project=`) and the drawer's
  // full-record link (`?open=<id>`). Consumed: stripped from the URL so a
  // reload does not repeat them, and counted, so the same action fires again
  // on the section already on screen (where only the query string changes).
  const [intent, setIntent] = useState<WorkspaceIntent>({ request: 0, create: false });
  useEffect(() => {
    const create = search.get("create") === "1";
    const openId = search.get("open") ?? undefined;
    if (!create && !openId) return;
    setIntent((prev) => ({
      request: prev.request + 1,
      create,
      projectId: search.get("project") ?? undefined,
      openId,
    }));
    // History, not the router: this strips a consumed instruction from the
    // address; it is not navigation (the shell owns that — see the
    // navigation-architecture test). Next keeps useSearchParams in sync.
    const rest = new URLSearchParams(search.toString());
    for (const key of ["create", "project", "open"]) rest.delete(key);
    const qs = rest.toString();
    // `null` state, as Next documents: passing Next's own history state would
    // mark this as its internal entry and useSearchParams would never sync,
    // so the next «+ ایجاد» to the same URL would look like no change at all.
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [search]);
  const create = { intent };
  const held = useMemo(() => new Set(permissions), [permissions]);
  const canManage = held.has(PERMISSIONS.workspaceManage);
  const canManageContracts = held.has(PERMISSIONS.workspaceContractsManage);
  const canApprove = held.has(PERMISSIONS.workspaceApprove);

  return (
    <div className="space-y-6">
      {activeSection === "overview" ? <OverviewSection /> : null}
      {activeSection === "projects" ? (
        <ProjectsSection lookups={lookups} canManage={canManage} {...create} />
      ) : null}
      {activeSection === "tasks" ? (
        <TasksSection lookups={lookups} canManage={canManage} initialMine={initialMine} {...create} />
      ) : null}
      {activeSection === "calendar" ? (
        <CalendarSection lookups={lookups} canManage={canManage} {...create} />
      ) : null}
      {activeSection === "documents" ? (
        <DocumentsSection
          lookups={lookups}
          canManage={canManage}
          canRequestApproval={canManage}
          {...create}
        />
      ) : null}
      {activeSection === "contracts" ? (
        <ContractsSection
          lookups={lookups}
          canManageContracts={canManageContracts}
          canRequestApproval={canManage}
          initialExpiring={initialExpiring}
          {...create}
        />
      ) : null}
      {activeSection === "teams" ? <TeamsSection lookups={lookups} canManage={canManage} intent={intent} /> : null}
      {activeSection === "approvals" ? <ApprovalsSection canApprove={canApprove} initialInbox={initialMine ? "mine" : "all"} /> : null}
      {activeSection === "reports" ? <ReportsSection /> : null}
      {activeSection === "templates" ? <TemplatesSection canManage={canManage} /> : null}
    </div>
  );
}
