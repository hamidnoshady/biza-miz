/**
 * Issue #799 §23 — the assistant's AEC read tools.
 *
 * The issue names two, and names them *read* tools on purpose: the first thing
 * the assistant should do for a construction business is answer questions from
 * data that already exists, before it is trusted to change anything. Both are
 * strictly read-only and both call the same service functions the screens call
 * (`projectReport`, `loadProjectAecProfile`, `listWorkspaceTasks`), so an
 * answer and the cockpit can never disagree. Writes still go through
 * `propose_action` and a human pressing «اعمال».
 *
 *   - `get_aec_project_financial_health` — one project's commercial position:
 *     budget, posted cost, contract value, unapproved/overdue work, and the
 *     planned-versus-reported physical progress that §5 keeps as two columns.
 *   - `list_delayed_project_activities` — what is late, across the business or
 *     within one project: overdue tasks and overdue phases.
 *   - `get_boq_variance` (Wave 4) — the approved estimate against the ledger's
 *     actual cost, per chapter and in total. §23 names this one
 *     (`get_boq_variance`) and §23's own rule is why the cost side is read from
 *     Accounting through the same `projectReport` the cockpit uses: the
 *     assistant never recomputes a posted financial fact.
 *   - `get_latest_drawing_revision` (Wave 5) — §23's question «آخرین رویژن نقشه
 *     سازه پروژه A01 چیست؟», answered from the drawing register the documents
 *     tab shows, so the answer and the screen are the same rows.
 *   - `list_pending_rfis` and `list_pending_submittals` (Wave 6) — §23's two
 *     pending lists, which are also the two Persian questions the same section
 *     writes out («RFIهای بدون پاسخ این هفته چیست؟» and «چه سابمیتال‌هایی منتظر
 *     تأیید هستند؟»). Both call the queue functions the RFI and submittal tabs
 *     use, so «بدون پاسخ» means the same rows in a chat answer and on screen.
 *
 * A business of another industry is refused rather than answered: an empty list
 * would read as "nothing is late", which is a claim about a café's construction
 * projects that no one should make. The refusal is a sentence the model can
 * relay, not an error code.
 */
import { AEC_AI_TOOL_LABELS, AEC_AI_TOOL_NAMES, type AecAiToolName } from "./aec";
import { AecError, type AecProjectProfile, loadProjectAecProfile } from "./aec-service";
import { boqVariance } from "./aec-boq-service";
import { latestDrawingRevisions } from "./aec-doc-service";
import { pendingRfis, pendingSubmittals } from "./aec-rfi-service";
import { businessToday } from "./business-day-service";
import { formatJalali } from "./jalali";
import { daysUntil } from "./workspace-shared";
import {
  getWorkspaceProject,
  listPhases,
  listWorkspaceProjects,
  listWorkspaceTasks,
  projectReport,
} from "./workspace";

export { AEC_AI_TOOL_LABELS, AEC_AI_TOOL_NAMES };

export function isAecAiToolName(name: string): name is AecAiToolName {
  return (AEC_AI_TOOL_NAMES as readonly string[]).includes(name);
}

export interface AecToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * The project a question names.
 *
 * The same three-way answer the workspace tools give — found, none, ambiguous —
 * because a person asks by name and guessing between two projects called
 * «برج شمال» would report the wrong margin with full confidence. The candidate
 * list is what the model is told to ask the user about.
 */
async function resolveProject(
  businessId: string,
  args: Record<string, unknown>,
): Promise<
  | { kind: "found"; projectId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ projectId: string; name: string }> }
> {
  const id = typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : null;
  if (id) {
    const project = await getWorkspaceProject(businessId, id);
    return project ? { kind: "found", projectId: project.id } : { kind: "none" };
  }
  const name = typeof args.projectName === "string" ? args.projectName.trim() : "";
  if (!name) return { kind: "none" };

  const matches = await listWorkspaceProjects(businessId, { search: name, status: "all" });
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "found", projectId: matches[0].id };
  const exact = matches.filter((project) => project.name.trim() === name);
  if (exact.length === 1) return { kind: "found", projectId: exact[0].id };
  return {
    kind: "ambiguous",
    candidates: matches.slice(0, 10).map((project) => ({ projectId: project.id, name: project.name })),
  };
}

/** The AEC half of a project's record, as the model should read it. */
function describeAecProfile(profile: AecProjectProfile | null): Record<string, unknown> {
  if (!profile) {
    return { recorded: false, note: "شناسنامهٔ عمرانی این پروژه هنوز ثبت نشده است." };
  }
  return {
    recorded: true,
    projectNumber: profile.projectNumber,
    projectCategory: profile.projectCategory,
    siteName: profile.siteName,
    city: profile.city,
    region: profile.region,
    landArea: profile.landArea,
    builtArea: profile.builtArea,
    floorCount: profile.floorCount,
    employer: profile.employerPartyName,
    leadConsultant: profile.leadConsultantPartyName,
    mainContractor: profile.mainContractorPartyName,
    projectManager: profile.projectManagerName,
    contractMethod: profile.contractMethod,
    deliveryMethod: profile.deliveryMethod,
    permitNumbers: profile.permitNumbers,
    plannedStartDate: profile.plannedStartDate,
    plannedEndDate: profile.plannedEndDate,
    actualStartDate: profile.actualStartDate,
    actualEndDate: profile.actualEndDate,
    // §5 keeps these as two columns; the difference is the useful number.
    plannedPhysicalProgress: profile.plannedPhysicalProgress,
    reportedPhysicalProgress: profile.reportedPhysicalProgress,
  };
}

async function runTool(
  name: AecAiToolName,
  args: Record<string, unknown>,
  businessId: string,
): Promise<AecToolResult> {
  const today = await businessToday(businessId);

  switch (name) {
    case "get_aec_project_financial_health": {
      const resolved = await resolveProject(businessId, args);
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
      if (resolved.kind === "none") return { ok: false, error: "پروژه پیدا نشد." };

      const [project, profile, report, tasks, phases] = await Promise.all([
        getWorkspaceProject(businessId, resolved.projectId),
        loadProjectAecProfile(businessId, resolved.projectId),
        projectReport(businessId),
        listWorkspaceTasks(businessId, { projectId: resolved.projectId, status: "all", limit: 200 }),
        listPhases(resolved.projectId),
      ]);
      if (!project) return { ok: false, error: "پروژه پیدا نشد." };

      const financials = report.find((row) => row.projectId === resolved.projectId);
      const spent = financials?.spentRial ?? 0;
      const contractValue = financials?.contractValueRial ?? 0;
      const open = tasks.filter((task) => task.status !== "done");
      const overdue = open.filter((task) => task.dueDate && task.dueDate < today);
      const latePhases = phases.filter(
        (phase) => phase.status !== "done" && phase.status !== "skipped" && phase.endDate && phase.endDate < today,
      );

      return {
        ok: true,
        data: {
          projectId: project.id,
          name: project.name,
          status: project.status,
          customer: project.partyName,
          startDate: project.startDate,
          endDate: project.endDate,
          aec: describeAecProfile(profile),
          // Money in rial, exactly as the ledger holds it — the model must
          // quote the unit rather than invent a conversion.
          budgetRial: project.budgetRial,
          spentRial: spent,
          remainingBudgetRial: project.budgetRial === null ? null : project.budgetRial - spent,
          contractValueRial: contractValue,
          // Contract value is revenue, cost is what the ledger has posted;
          // both are stated plainly rather than pre-divided into a margin the
          // data cannot support (no revenue recognition exists yet).
          budgetUsedPercent:
            project.budgetRial && project.budgetRial > 0
              ? Math.round((spent / project.budgetRial) * 1000) / 10
              : null,
          taskCount: tasks.length,
          openTaskCount: open.length,
          overdueTaskCount: overdue.length,
          latePhaseCount: latePhases.length,
          pendingApprovalCount: financials?.openApprovals ?? 0,
          today,
          note: "ارقام ریالی از اسناد حسابداری همین پروژه خوانده شده‌اند، نه از برآورد.",
        },
      };
    }

    case "get_boq_variance": {
      const resolved = await resolveProject(businessId, args);
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
      if (resolved.kind === "none") return { ok: false, error: "پروژه پیدا نشد." };

      let variance;
      try {
        variance = await boqVariance(businessId, resolved.projectId);
      } catch (err) {
        // The business estimates nothing (its operating profile has the `boq`
        // capability off), or is not AEC at all — both answered with a sentence
        // the model can relay, never with a fabricated zero.
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "این کسب‌وکار متره و برآورد فعال ندارد. اگر لازم است، از «تنظیمات ← کسب‌وکار» قابلیت متره و برآورد را روشن کنید.",
          };
        }
        throw err;
      }
      if (!variance) return { ok: false, error: "پروژه پیدا نشد." };

      return {
        ok: true,
        data: {
          ...variance,
          today,
          note:
            variance.approvedEstimateRial === null
              ? "هنوز برآورد تأییدشده‌ای برای این پروژه ثبت نشده است؛ هزینهٔ واقعی از اسناد حسابداری خوانده شده است."
              : "هزینهٔ واقعی از اسناد حسابداری همین پروژه خوانده شده است، نه از برآورد.",
        },
      };
    }

    case "get_latest_drawing_revision": {
      const resolved = await resolveProject(businessId, args);
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

      const discipline = typeof args.discipline === "string" ? args.discipline.trim() : "";
      const search = typeof args.search === "string" ? args.search.trim() : "";
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      let drawings;
      try {
        drawings = await latestDrawingRevisions(businessId, {
          projectId: resolved.kind === "found" ? resolved.projectId : undefined,
          search,
          discipline,
          limit,
        });
      } catch (err) {
        // Document control is off for this business (its operating profile
        // leaves the capability out), or it is not AEC at all. Both are
        // answered with a sentence rather than an invented empty register.
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "این کسب‌وکار کنترل نقشه و مستندات فعال ندارد. اگر لازم است، از «تنظیمات ← کسب‌وکار» قابلیت آن را روشن کنید.",
          };
        }
        throw err;
      }
      if (resolved.kind === "none") return { ok: false, error: "پروژه پیدا نشد." };

      return {
        ok: true,
        data: {
          // The count matters: «آخرین رویژن» is a claim about a specific
          // document, so an empty list has to be readable as "this filter
          // matched nothing" rather than "this project has no drawings".
          drawings,
          count: drawings.length,
          projectScoped: resolved.kind === "found",
          disciplineFilter: discipline || null,
          search: search || null,
          today,
          note:
            drawings.length === 0
              ? "برای این فیلتر نقشه‌ای در دفتر ثبت نشده است. اگر انتظار داشتید نقشه‌ای باشد، فیلتر رشته یا جست‌وجو را بازتر کنید."
              : "این فهرست از دفتر نقشه‌های همین کسب‌وکار خوانده شده است؛ «بازنگری جاری» بالاترین شمارهٔ بازنگری هر سند است.",
        },
      };
    }

    case "list_delayed_project_activities": {
      const resolved = await resolveProject(businessId, args);
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

      const projectId = resolved.kind === "found" ? resolved.projectId : undefined;
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const [tasks, phases] = await Promise.all([
        listWorkspaceTasks(businessId, { projectId, status: "open_only", limit: 200 }),
        projectId ? listPhases(projectId) : Promise.resolve([]),
      ]);

      const delayedTasks = tasks
        .filter((task) => task.dueDate && task.dueDate < today)
        .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
      // Phases carry no project id here (the list is already project-scoped),
      // so the overdue-phase half answers only when one project was named.
      const delayedPhases = phases.filter(
        (phase) => phase.status !== "done" && phase.status !== "skipped" && phase.endDate && phase.endDate < today,
      );

      return {
        ok: true,
        data: {
          today,
          projectId: projectId ?? null,
          delayedTaskCount: delayedTasks.length,
          delayedPhaseCount: delayedPhases.length,
          tasks: delayedTasks.slice(0, limit).map((task) => ({
            taskId: task.id,
            title: task.title,
            project: task.projectName,
            projectId: task.projectId,
            priority: task.priority,
            assignee: task.assigneeName,
            phase: task.phaseName,
            dueDate: task.dueDate,
            dueDateJalali: task.dueDate ? formatJalali(task.dueDate) : null,
            daysLate: task.dueDate ? Math.abs(daysUntil(task.dueDate, today) ?? 0) : null,
          })),
          phases: delayedPhases.slice(0, limit).map((phase) => ({
            phaseId: phase.id,
            name: phase.name,
            status: phase.status,
            endDate: phase.endDate,
            endDateJalali: phase.endDate ? formatJalali(phase.endDate) : null,
            taskCount: phase.taskCount,
            doneTaskCount: phase.doneTaskCount,
          })),
        },
      };
    }

    case "list_pending_rfis": {
      const resolved = await resolveProject(businessId, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);

      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      const windowDays = Number(args.dueWithinDays);
      const rfis = await pendingRfis(businessId, {
        projectId: resolved.kind === "found" ? resolved.projectId : undefined,
        limit,
      });
      // «RFIهای بدون پاسخ این هفته» is a question about a window, so the model
      // can pass one; the service's own queue is unwindowed because a screen
      // wants the whole list.
      const scoped =
        Number.isFinite(windowDays) && windowDays > 0
          ? rfis.filter((rfi) => {
              if (!rfi.dueDate) return false;
              const days = daysUntil(rfi.dueDate, today) ?? 0;
              return days <= windowDays;
            })
          : rfis;

      const withJalali = scoped.map((rfi) => ({
        ...rfi,
        dueDateJalali: rfi.dueDate ? formatJalali(rfi.dueDate) : null,
        overdue: rfi.daysOverdue > 0,
      }));
      return {
        ok: true,
        data: {
          rfis: withJalali,
          count: withJalali.length,
          overdueCount: withJalali.filter((rfi) => rfi.overdue).length,
          projectScoped: resolved.kind === "found",
          dueWithinDays: Number.isFinite(windowDays) && windowDays > 0 ? windowDays : null,
          today,
          note:
            withJalali.length === 0
              ? "هیچ استعلام بی‌پاسخی با این فیلترها نیست."
              : "«بدون پاسخ» یعنی استعلام‌هایی که هنوز پاسخ نگرفته‌اند؛ عقب‌افتاده‌ها اول می‌آیند.",
        },
      };
    }

    case "list_pending_submittals": {
      const resolved = await resolveProject(businessId, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);

      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      const windowDays = Number(args.dueWithinDays);
      let submittals;
      try {
        submittals = await pendingSubmittals(businessId, {
          projectId: resolved.kind === "found" ? resolved.projectId : undefined,
          limit,
        });
      } catch (err) {
        // Same refusal as the drawing read: document control is off by preset
        // for the design-and-approval-lean profiles, and «no submittals» would
        // read as a fact about the project rather than a switch.
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "این کسب‌وکار کنترل نقشه و مستندات (و در نتیجه سابمیتال‌ها) فعال ندارد. اگر لازم است، از «تنظیمات ← کسب‌وکار» قابلیت آن را روشن کنید.",
          };
        }
        throw err;
      }
      const scoped =
        Number.isFinite(windowDays) && windowDays > 0
          ? submittals.filter((submittal) => {
              if (!submittal.dueDate) return false;
              const days = daysUntil(submittal.dueDate, today) ?? 0;
              return days <= windowDays;
            })
          : submittals;

      const withJalali = scoped.map((submittal) => ({
        ...submittal,
        dueDateJalali: submittal.dueDate ? formatJalali(submittal.dueDate) : null,
        overdue: submittal.daysOverdue > 0,
      }));
      return {
        ok: true,
        data: {
          submittals: withJalali,
          count: withJalali.length,
          overdueCount: withJalali.filter((submittal) => submittal.overdue).length,
          projectScoped: resolved.kind === "found",
          dueWithinDays: Number.isFinite(windowDays) && windowDays > 0 ? windowDays : null,
          today,
          note:
            withJalali.length === 0
              ? "هیچ سابمیتالی با این فیلترها منتظر تأیید نیست."
              : "«منتظر تأیید» یعنی بازنگری‌های ارسال‌شده یا در حال بررسی؛ تأییدشده‌ها اینجا نیستند.",
        },
      };
    }
  }
}

/** The one sentence every project-scoped read gives when a name matched twice. */
function ambiguousProject(
  candidates: Array<{ projectId: string; name: string }>,
): AecToolResult {
  return {
    ok: true,
    data: {
      ambiguous: true,
      message: "چند پروژه با این نام هست؛ از کاربر بپرس کدام را می‌خواهد.",
      candidates,
    },
  };
}

/**
 * Run one AEC read tool. `industry` is passed in rather than re-read here so
 * the caller that already resolved it (the assistant's turn) cannot drift from
 * this decision.
 */
export async function runAecReadTool(
  name: string,
  args: Record<string, unknown>,
  businessId: string,
  industry: string | null,
): Promise<AecToolResult> {
  if (!isAecAiToolName(name)) return { ok: false, error: "ابزار ناشناخته." };
  if (industry !== "architecture_construction") {
    return {
      ok: false,
      error: "این ابزار فقط برای کسب‌وکارهای مهندسی عمران، معماری و پیمانکاری است.",
    };
  }
  return runTool(name, args, businessId);
}
