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

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { PERMISSIONS } from "@/lib/permissions";
import { useWorkspaceLookups } from "./use-workspace-lookups";
import { type WorkspaceSection } from "./workspace-routes";
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
  // «+ ایجاد» from the command bar: `?create=1` opens the section's create
  // dialog, `?project=` preselects the project it was started from.
  const initialCreating = search.get("create") === "1";
  const createProjectId = search.get("project") ?? undefined;
  const create = { initialCreating, createProjectId };
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
      {activeSection === "teams" ? <TeamsSection lookups={lookups} canManage={canManage} initialProjectId={createProjectId} /> : null}
      {activeSection === "approvals" ? <ApprovalsSection canApprove={canApprove} /> : null}
      {activeSection === "reports" ? <ReportsSection /> : null}
      {activeSection === "templates" ? <TemplatesSection canManage={canManage} /> : null}
    </div>
  );
}
