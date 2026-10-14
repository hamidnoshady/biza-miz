/**
 * The assistant's read tools for «میز کار من».
 *
 * Four questions the brief names, one tool each:
 *
 *  - «وضعیت پروژهٔ X چیست؟»          → `get_workspace_project_status`
 *  - «چه کارهایی امروز/این هفته دارم؟» → `list_workspace_tasks`
 *  - «کدام قراردادها ماه آینده منقضی می‌شوند؟» → `list_expiring_contracts`
 *  - «چه چیزی منتظر تأیید من است؟»    → `list_workspace_approvals`
 *
 * These are executors, not a second data layer: every one calls the same
 * `src/lib/workspace.ts` function the API routes call, so the assistant's
 * answer and the screen's list can never disagree. They are strictly
 * read-only — a change to a project still goes through `propose_action` and a
 * human pressing «اعمال», like every other write the assistant touches.
 *
 * Dates cross this boundary as ISO/Gregorian because that is what the model
 * reasons about and what the DB stores; the Persian rendering happens where
 * the answer is displayed. The one exception is `expiresBeforeJalali`, a
 * convenience field so an answer can quote the Shamsi date the user asked in.
 */
import { formatJalali, todayIsoDate } from "./jalali";
import {
  getWorkspaceProject,
  listApprovals,
  listContracts,
  listMembers,
  listPhases,
  listWorkspaceProjects,
  listWorkspaceTasks,
  projectReport,
  resolveProjectRole,
  WorkspaceError,
  type WorkspaceOwner,
} from "./workspace";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
  TASK_STATUS_LABELS,
  completionPercent,
  daysUntil,
  type WorkspaceContractStatus,
  type WorkspacePriority,
  type WorkspaceTaskStatus,
} from "./workspace-shared";

/**
 * The tool names and labels are re-exported from the pure module, where they
 * are defined. Server callers can keep importing them from here (the executor
 * is what they want anyway); a client component must import them from
 * `workspace-shared` directly, or it drags `pg` into the browser bundle.
 */
export {
  WORKSPACE_TOOL_LABELS,
  WORKSPACE_TOOL_NAMES,
  isWorkspaceToolName,
  type WorkspaceToolName,
} from "./workspace-shared";

// A re-export does not bind the name locally; this file's own signatures use it.
import type { WorkspaceToolName } from "./workspace-shared";

function cap<T>(rows: T[], limit: number): T[] {
  return rows.slice(0, limit);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the project the user named. The model is given project ids by the
 * other tools, but a person asks by name — so a name match is accepted and,
 * when it is ambiguous, the candidates are returned instead of a guess. An
 * assistant that picks one of two projects called «برج شمال» silently reports
 * the wrong budget.
 */
async function resolveProject(
  owner: WorkspaceOwner,
  args: Record<string, unknown>,
): Promise<
  | { kind: "found"; projectId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ projectId: string; name: string }> }
> {
  const id = asString(args.projectId);
  if (id) {
    // The same access rule as the project page: a project the caller cannot
    // open is "not found", never a status report.
    const role = await resolveProjectRole(owner, id).catch((err) => {
      if (err instanceof WorkspaceError) return null;
      throw err;
    });
    if (role) return { kind: "found", projectId: id };
  }
  const name = asString(args.projectName) ?? asString(args.name);
  if (!name) return { kind: "none" };

  const matches = await listWorkspaceProjects(owner, { search: name, status: "all" });
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "found", projectId: matches[0].id };

  const exact = matches.filter((p) => p.name.trim() === name);
  if (exact.length === 1) return { kind: "found", projectId: exact[0].id };

  return {
    kind: "ambiguous",
    candidates: cap(
      matches.map((p) => ({ projectId: p.id, name: p.name })),
      10,
    ),
  };
}

export interface WorkspaceToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execute one workspace read tool.
 *
 * `owner` is the signed-in member with their access flags. It is the ONLY
 * source of "mine" — `mine: true` means the caller, never a user id the model
 * supplies — and every read goes through the same project-access scope as the
 * screens, so the assistant cannot answer about a project the member cannot
 * open.
 */
export async function runWorkspaceReadTool(
  name: WorkspaceToolName,
  args: Record<string, unknown>,
  owner: WorkspaceOwner,
): Promise<WorkspaceToolResult> {
  const { businessId, actorUserId } = owner;
  switch (name) {
    case "get_workspace_project_status": {
      const resolved = await resolveProject(owner, args);
      if (resolved.kind === "none") {
        return { ok: false, error: "پروژه‌ای با این نام یا شناسه پیدا نشد." };
      }
      if (resolved.kind === "ambiguous") {
        return {
          ok: true,
          data: {
            ambiguous: true,
            message: "چند پروژه با این نام هست؛ از کاربر بپرس کدام را می‌خواهد.",
            candidates: resolved.candidates,
          },
        };
      }

      const projectId = resolved.projectId;
      const [project, phases, members, tasks, contracts, approvals, report] = await Promise.all([
        getWorkspaceProject(businessId, projectId),
        listPhases(projectId),
        listMembers(projectId),
        listWorkspaceTasks(owner, { projectId, status: "all", limit: 200 }),
        listContracts(owner, { projectId, status: "all" }),
        listApprovals(owner, { projectId, status: "pending" }),
        projectReport(owner, { projectId }),
      ]);
      if (!project) return { ok: false, error: "پروژه پیدا نشد." };

      const financials = report.find((row) => row.projectId === projectId);
      const today = todayIsoDate();
      const openTasks = tasks.filter((task) => task.status !== "done");
      const overdue = openTasks.filter((task) => task.dueDate && task.dueDate < today);

      return {
        ok: true,
        data: {
          projectId: project.id,
          name: project.name,
          status: project.status,
          statusLabel: PROJECT_STATUS_LABELS[project.status],
          priority: project.priority,
          projectType: project.projectType,
          customer: project.partyName,
          owner: project.ownerName,
          startDate: project.startDate,
          endDate: project.endDate,
          endDateJalali: project.endDate ? formatJalali(project.endDate) : null,
          daysToDeadline: project.endDate ? daysUntil(project.endDate, today) : null,
          tags: project.tags,
          completionPercent: completionPercent(project.doneTaskCount, project.taskCount),
          taskCount: project.taskCount,
          doneTaskCount: project.doneTaskCount,
          openTaskCount: openTasks.length,
          overdueTaskCount: overdue.length,
          // The money comes from the ledger, not from a workspace counter.
          budgetRial: project.budgetRial,
          // Null when the member may not read the ledger — never a 0 that
          // reads as "nothing spent".
          spentRial: financials?.spentRial ?? null,
          remainingBudgetRial:
            project.budgetRial === null || financials?.spentRial == null
              ? null
              : project.budgetRial - financials.spentRial,
          contractValueRial: financials?.contractValueRial ?? 0,
          pendingApprovalCount: approvals.length,
          phases: cap(
            phases.map((phase) => ({
              name: phase.name,
              status: phase.status,
              endDate: phase.endDate,
              taskCount: phase.taskCount,
              doneTaskCount: phase.doneTaskCount,
            })),
            20,
          ),
          team: cap(
            members.map((member) => ({ name: member.fullName, role: member.role })),
            20,
          ),
          contracts: cap(
            contracts.map((contract) => ({
              contractId: contract.id,
              title: contract.title,
              type: CONTRACT_TYPE_LABELS[contract.contractType],
              party: contract.partyName,
              status: CONTRACT_STATUS_LABELS[contract.status],
              valueRial: contract.valueRial,
              endDate: contract.endDate,
            })),
            20,
          ),
          nextDeadlines: cap(
            openTasks
              .filter((task) => task.dueDate)
              .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
              .map((task) => ({
                title: task.title,
                dueDate: task.dueDate,
                dueDateJalali: task.dueDate ? formatJalali(task.dueDate) : null,
                assignee: task.assigneeName,
                status: task.status,
              })),
            10,
          ),
        },
      };
    }

    case "list_workspace_tasks": {
      const mine = args.mine === true || args.mine === "true";
      const resolved =
        asString(args.projectId) || asString(args.projectName)
          ? await resolveProject(owner, args)
          : null;
      if (resolved?.kind === "ambiguous") {
        return {
          ok: true,
          data: {
            ambiguous: true,
            message: "چند پروژه با این نام هست؛ از کاربر بپرس کدام را می‌خواهد.",
            candidates: resolved.candidates,
          },
        };
      }

      const status = asString(args.status);
      const tasks = await listWorkspaceTasks(owner, {
        projectId: resolved?.kind === "found" ? resolved.projectId : undefined,
        // "Mine" is the caller. A model-supplied user id is never accepted.
        assigneeUserId: mine ? actorUserId : undefined,
        status:
          status === "all" || status === "open_only"
            ? (status as "all" | "open_only")
            : status
              ? (status as WorkspaceTaskStatus)
              : "open_only",
        priority: asString(args.priority) as WorkspacePriority | undefined,
        dueBefore: asString(args.dueBefore),
        dueAfter: asString(args.dueAfter),
        search: asString(args.search),
        limit: Math.min(asNumber(args.limit) ?? 50, 100),
      });

      const today = todayIsoDate();
      return {
        ok: true,
        data: {
          count: tasks.length,
          overdueCount: tasks.filter(
            (task) => task.status !== "done" && task.dueDate && task.dueDate < today,
          ).length,
          tasks: cap(
            tasks.map((task) => ({
              taskId: task.id,
              title: task.title,
              project: task.projectName,
              projectId: task.projectId,
              status: task.status,
              statusLabel: TASK_STATUS_LABELS[task.status],
              priority: task.priority,
              assignee: task.assigneeName,
              dueDate: task.dueDate,
              dueDateJalali: task.dueDate ? formatJalali(task.dueDate) : null,
              daysToDue: task.dueDate ? daysUntil(task.dueDate, today) : null,
              customer: task.partyName,
              phase: task.phaseName,
              checklist: `${task.checklistDone}/${task.checklistTotal}`,
              blockedByCount: task.blockedBy,
            })),
            60,
          ),
        },
      };
    }

    case "list_expiring_contracts": {
      // «ماه آینده» is 30 days unless the caller says otherwise. The search
      // spans the whole workspace, which is the question's actual scope: a
      // person asking which contracts expire soon does not mean "within the
      // project I happen to have open".
      const withinDays = Math.min(Math.max(asNumber(args.withinDays) ?? 30, 1), 365);
      const contracts = await listContracts(owner, {
        expiringWithinDays: withinDays,
        status: (asString(args.status) as WorkspaceContractStatus | "all") ?? "all",
        projectId: asString(args.projectId),
      });
      const today = todayIsoDate();

      return {
        ok: true,
        data: {
          withinDays,
          count: contracts.length,
          note: "این‌ها قراردادهای اجرایی پروژه هستند (پیمانکار، تأمین‌کننده، مشاور). قراردادهای رابطه‌ای مشتری در پروندهٔ مشتری در CRM نگهداری می‌شوند.",
          contracts: cap(
            contracts.map((contract) => ({
              contractId: contract.id,
              title: contract.title,
              type: CONTRACT_TYPE_LABELS[contract.contractType],
              party: contract.partyName,
              project: contract.projectName,
              status: CONTRACT_STATUS_LABELS[contract.status],
              valueRial: contract.valueRial,
              startDate: contract.startDate,
              endDate: contract.endDate,
              endDateJalali: contract.endDate ? formatJalali(contract.endDate) : null,
              daysToExpiry: contract.endDate ? daysUntil(contract.endDate, today) : null,
              reminderDays: contract.reminderDays,
              approvalStatus: contract.approvalStatus,
            })),
            50,
          ),
        },
      };
    }

    case "list_workspace_approvals": {
      const mine = args.mine === true || args.mine === "true";
      const approvals = await listApprovals(owner, {
        status: (asString(args.status) as "pending") ?? "pending",
        awaitingActor: mine,
        limit: Math.min(asNumber(args.limit) ?? 50, 100),
      });
      const today = todayIsoDate();

      return {
        ok: true,
        data: {
          count: approvals.length,
          approvals: cap(
            approvals.map((approval) => ({
              approvalId: approval.id,
              subject: approval.subjectTitle || approval.title,
              subjectType: approval.subjectType,
              project: approval.projectName,
              status: approval.status,
              requestedBy: approval.requestedByName,
              approver: approval.approverName,
              dueDate: approval.dueDate,
              dueDateJalali: approval.dueDate ? formatJalali(approval.dueDate) : null,
              overdue: Boolean(approval.dueDate && approval.dueDate < today),
            })),
            50,
          ),
        },
      };
    }
  }
}
