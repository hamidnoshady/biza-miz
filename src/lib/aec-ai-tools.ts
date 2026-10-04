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
 *   - `list_site_issues` (Wave 7) — §23's site and quality queue: every open
 *     inspection, NCR, corrective action, snag and HSE observation, most severe
 *     first and with its overdue flag, read from the same register the
 *     «بازرسی و کنترل کیفیت» tab shows.
 *   - `list_change_orders`, `list_payment_certificates` and
 *     `list_project_commercial_risks` (Wave 8) — §23's commercial three. The
 *     first two are §23's own names, read from the same change-order and
 *     certificate registers the tabs read; the third answers the question the
 *     section poses in Persian («چه ریسک‌های تجاری …») by putting the open
 *     changes, the uncertified claims, the certified claims the books have not
 *     seen money for, and the bonds approaching expiry into one answer — with
 *     every money figure labelled by who owns it (Workspace or Accounting)
 *     rather than silently mixed.
 *   - `list_upcoming_milestones` (Wave 10) — §22's «نقاط عطف پیش رو» widget and
 *     §23's "what is due next" question. The delayed list answers what has
 *     already slipped; this one reads the same three dated things (a phase's end
 *     date, an open task's due date, a project's end date) in the *other*
 *     direction, so a widget can be offered whose prompt a read can actually
 *     answer.
 *   - `list_procurement_delays` (Wave 9) — §23's procurement-delay question, and
 *     the data behind §22's widget of the same name and §29's warning. It names
 *     both halves honestly: the awards a supplier is late on (with how many days
 *     and how much money they are worth) and the material requests still waiting
 *     on an approval. Nothing about Accounting is claimed — a late delivery is a
 *     Workspace fact, and whether the invoice was posted is a different page.
 *
 * A business of another industry is refused rather than answered: an empty list
 * would read as "nothing is late", which is a claim about a café's construction
 * projects that no one should make. The refusal is a sentence the model can
 * relay, not an error code.
 */
import { AEC_AI_TOOL_LABELS, AEC_AI_TOOL_NAMES, type AecAiToolName } from "./aec";
import {
  AecError,
  type AecProjectProfile,
  loadProjectAecProfile,
  upcomingProjectMilestones,
} from "./aec-service";
import { boqVariance } from "./aec-boq-service";
import {
  certifiedClaimsAwaitingPayment,
  expiringSecurities,
  getProjectCommercialSummary,
  listProjectCertificates,
  listProjectVariations,
  pendingCertificates,
  pendingVariations,
} from "./aec-commercial-service";
import { latestDrawingRevisions } from "./aec-doc-service";
import { delayedCommitments, pendingMaterialRequests } from "./aec-procurement-service";
import { pendingRfis, pendingSubmittals } from "./aec-rfi-service";
import { pendingSiteIssues } from "./aec-site-service";
import { SITE_ISSUE_STATUS_LABELS, type SiteIssueStatus } from "./aec-site";
import { businessToday } from "./business-day-service";
import { formatJalali } from "./jalali";
import { daysUntil } from "./workspace-shared";
import type { WorkspaceOwner } from "./workspace";
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
  owner: WorkspaceOwner,
  args: Record<string, unknown>,
): Promise<
  | { kind: "found"; projectId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: Array<{ projectId: string; name: string }> }
> {
  const id = typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : null;
  if (id) {
    const project = await getWorkspaceProject(owner.businessId, id);
    return project ? { kind: "found", projectId: project.id } : { kind: "none" };
  }
  const name = typeof args.projectName === "string" ? args.projectName.trim() : "";
  if (!name) return { kind: "none" };

  const matches = await listWorkspaceProjects(owner, { search: name, status: "all" });
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
  owner: WorkspaceOwner,
): Promise<AecToolResult> {
  const businessId = owner.businessId;
  const today = await businessToday(businessId);

  switch (name) {
    case "get_aec_project_financial_health": {
      const resolved = await resolveProject(owner, args);
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
        projectReport(owner),
        listWorkspaceTasks(owner, { projectId: resolved.projectId, status: "all", limit: 200 }),
        listPhases(resolved.projectId),
      ]);
      if (!project) return { ok: false, error: "پروژه پیدا نشد." };

      const financials = report.find((row) => row.projectId === resolved.projectId);
      // `projectReport` reports spend as null to a caller without the ledger
      // permission — the same rule the finance card applies. The assistant
      // states that as unknown rather than as zero: a café-with-no-books answer
      // of «۰ ریال هزینه» is a claim, and a wrong one.
      const spent = financials?.spentRial ?? null;
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
          remainingBudgetRial:
            project.budgetRial === null || spent === null ? null : project.budgetRial - spent,
          contractValueRial: contractValue,
          // Contract value is revenue, cost is what the ledger has posted;
          // both are stated plainly rather than pre-divided into a margin the
          // data cannot support (no revenue recognition exists yet).
          budgetUsedPercent:
            project.budgetRial && project.budgetRial > 0 && spent !== null
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
      const resolved = await resolveProject(owner, args);
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
      const resolved = await resolveProject(owner, args);
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
      const resolved = await resolveProject(owner, args);
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
        listWorkspaceTasks(owner, { projectId, status: "open_only", limit: 200 }),
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
      const resolved = await resolveProject(owner, args);
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
      const resolved = await resolveProject(owner, args);
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

    case "list_site_issues": {
      const resolved = await resolveProject(owner, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);

      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : undefined;
      const severity =
        typeof args.severity === "string" && args.severity.trim() ? args.severity.trim() : undefined;
      let issues;
      try {
        issues = await pendingSiteIssues(businessId, {
          projectId: resolved.kind === "found" ? resolved.projectId : undefined,
          kind,
          severity,
          overdueOnly: args.overdueOnly === true,
          limit,
        });
      } catch (err) {
        // §14's register is the `qa_qc` capability; a design-lean preset that
        // does not keep one would otherwise be told "nothing is open", which is
        // a claim about a project rather than a switch.
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "این کسب‌وکار کنترل کیفیت و بازرسی (qa_qc) فعال ندارد، پس دفتر بازرسی و نقص‌ها خالی نیست بلکه وجود ندارد. اگر لازم است، از «تنظیمات ← کسب‌وکار» قابلیت آن را روشن کنید.",
          };
        }
        throw err;
      }

      const rows = issues.map((issue) => ({
        ...issue,
        statusLabel: SITE_ISSUE_STATUS_LABELS[issue.status as SiteIssueStatus] ?? issue.status,
        dueDateJalali: issue.dueDate ? formatJalali(issue.dueDate) : null,
        overdue: issue.daysOverdue > 0,
      }));
      return {
        ok: true,
        data: {
          issues: rows,
          count: rows.length,
          overdueCount: rows.filter((issue) => issue.overdue).length,
          criticalCount: rows.filter((issue) => issue.severity === "critical").length,
          projectScoped: resolved.kind === "found",
          today,
          note:
            rows.length === 0
              ? "با این فیلترها هیچ مورد بازی در کارگاه نیست."
              : "«باز» یعنی در جریان: باز، در دست اقدام یا اصلاح‌شده و منتظر تأیید. موارد بسته اینجا نیستند.",
        },
      };
    }

    case "list_change_orders": {
      const resolved = await resolveProject(owner, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);
      if (resolved.kind === "none") return { ok: false, error: "پروژه پیدا نشد." };

      const status = typeof args.status === "string" && args.status.trim() ? args.status.trim() : null;
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      let variations;
      try {
        variations = await listProjectVariations(businessId, resolved.projectId);
      } catch (err) {
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "این کسب‌وکار ثبت تغییرات و دستور کار (variations) فعال ندارد. برای ثبت و پیگیری تغییرات، از «تنظیمات ← کسب‌وکار» آن را روشن کنید.",
          };
        }
        throw err;
      }
      const filtered = (status ? variations.filter((row) => row.status === status) : variations).slice(
        0,
        limit,
      );
      return {
        ok: true,
        data: {
          variations: filtered.map((row) => ({
            ...row,
            submittedDateJalali: row.submittedDate ? formatJalali(row.submittedDate) : null,
            approvedDateJalali: row.approvedDate ? formatJalali(row.approvedDate) : null,
          })),
          count: filtered.length,
          total: variations.length,
          approvedTotalRial: variations
            .filter((row) => row.isApproved)
            .reduce((sum, row) => sum + (row.approvedAmountRial ?? 0), 0),
          today,
          note:
            "مبالغ این ابزار «توافق‌شده» است، نه پرداخت‌شده: پرداخت‌ها در حسابداری ثبت می‌شوند. تغییر تأییدشده ارزش اصلاح‌شدهٔ قرارداد را جابه‌جا می‌کند و مبلغ اصلی قرارداد را بازنویسی نمی‌کند.",
        },
      };
    }

    case "list_payment_certificates": {
      const resolved = await resolveProject(owner, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);
      if (resolved.kind === "none") return { ok: false, error: "پروژه پیدا نشد." };

      const status = typeof args.status === "string" && args.status.trim() ? args.status.trim() : null;
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      let certificates;
      try {
        certificates = await listProjectCertificates(businessId, resolved.projectId);
      } catch (err) {
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "این کسب‌وکار صورت‌وضعیت و گواهی پیشرفت (progress_claims) فعال ندارد. برای ثبت آن‌ها، از «تنظیمات ← کسب‌وکار» آن را روشن کنید.",
          };
        }
        throw err;
      }
      const filtered = (status ? certificates.filter((row) => row.status === status) : certificates).slice(
        0,
        limit,
      );
      const certified = certificates.filter((row) => row.isCertified);
      return {
        ok: true,
        data: {
          certificates: filtered.map((row) => ({
            ...row,
            submittedDateJalali: row.submittedDate ? formatJalali(row.submittedDate) : null,
            certifiedDateJalali: row.certifiedDate ? formatJalali(row.certifiedDate) : null,
            periodLabel: `${formatJalali(row.periodStart)} تا ${formatJalali(row.periodEnd)}`,
            approvedAmountRial: row.approvedAmountRial ?? row.currentCertifiedRial,
          })),
          count: filtered.length,
          total: certificates.length,
          certifiedTotalRial: certified.reduce(
            (sum, row) => sum + (row.approvedAmountRial ?? row.currentCertifiedRial),
            0,
          ),
          pendingCount: certificates.filter((row) => row.isOpen).length,
          today,
          note:
            "«مبلغ تأییدشده» یعنی آنچه گواهی شده است، نه آنچه وصول شده؛ دریافتی‌ها و مانده‌ها را از حسابداری بخوان و اگر در دسترس نیست بگو که در دسترس نیست.",
        },
      };
    }

    case "list_upcoming_milestones": {
      const resolved = await resolveProject(owner, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);
      const withinDays = Math.min(Math.max(Number(args.withinDays) || 30, 1), 365);
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      const milestones = await upcomingProjectMilestones(owner.businessId, {
        projectId: resolved.kind === "found" ? resolved.projectId : null,
        withinDays,
        limit,
      });

      return {
        ok: true,
        data: {
          today,
          withinDays,
          projectId: resolved.kind === "found" ? resolved.projectId : null,
          milestoneCount: milestones.length,
          milestones: milestones.map((milestone) => ({
            kind: milestone.kind,
            title: milestone.title,
            project: milestone.projectName,
            projectId: milestone.projectId,
            status: milestone.status,
            date: milestone.date,
            dateJalali: formatJalali(milestone.date),
            daysRemaining: milestone.daysRemaining,
            ...(milestone.kind === "phase"
              ? { taskCount: milestone.taskCount, doneTaskCount: milestone.doneTaskCount }
              : {}),
          })),
        },
      };
    }

    case "list_procurement_delays": {
      const resolved = await resolveProject(owner, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);
      if (resolved.kind === "none") return { ok: false, error: "پروژه پیدا نشد." };

      const afterDays = Math.min(Math.max(Number(args.afterDays) || 0, 0), 365);
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      let delays;
      let waiting;
      let summary;
      try {
        [delays, waiting, summary] = await Promise.all([
          delayedCommitments(businessId, { projectId: resolved.projectId, afterDays, limit }),
          pendingMaterialRequests(businessId, { projectId: resolved.projectId, limit }),
          getProjectCommercialSummary(owner, resolved.projectId),
        ]);
      } catch (err) {
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "تأمین و خرید روی این کسب‌وکار روشن نیست؛ برای دیدن تأخیرها، از «تنظیمات ← کسب‌وکار» قابلیت procurement را روشن کنید.",
          };
        }
        throw err;
      }

      return {
        ok: true,
        data: {
          project: { id: resolved.projectId, name: summary.projectName },
          delayedCommitments: delays.map((row) => ({
            ...row,
            expectedDeliveryDateJalali: formatJalali(row.expectedDeliveryDate),
          })),
          delayedCount: delays.length,
          delayedRial: delays.reduce((sum, row) => sum + row.valueRial, 0),
          pendingMaterialRequests: waiting.map((row) => ({
            ...row,
            requiredByJalali: row.requiredBy ? formatJalali(row.requiredBy) : null,
            submittedDateJalali: row.submittedDate ? formatJalali(row.submittedDate) : null,
          })),
          committedRial: summary.committedRial,
          deliveredRial: summary.deliveredRial,
          costToCompleteRial: summary.costToCompleteRial,
          forecastFinalCostRial: summary.forecastFinalCostRial,
          forecastBasis: summary.forecastBasis,
          today,
          note:
            "«تعهد» یعنی مبلغی که به تأمین‌کننده یا پیمان جزء تعهد شده و هنوز در حسابداری هزینهٔ ثبت‌شده نیست؛ پیش‌بینی هزینه هم فقط وقتی عدد دارد که هم هزینهٔ ثبت‌شده و هم برآورد مصوب موجود باشد، وگرنه null است.",
        },
      };
    }

    case "list_project_commercial_risks": {
      const resolved = await resolveProject(owner, args);
      if (resolved.kind === "ambiguous") return ambiguousProject(resolved.candidates);
      if (resolved.kind === "none") return { ok: false, error: "پروژه پیدا نشد." };

      const withinDays = Math.min(Math.max(Number(args.withinDays) || 60, 1), 365);
      let summary;
      let openChanges;
      let waitingCertificates;
      let awaitingPayment;
      let securities;
      try {
        [summary, openChanges, waitingCertificates, awaitingPayment, securities] = await Promise.all([
          getProjectCommercialSummary(owner, resolved.projectId),
          pendingVariations(businessId, { projectId: resolved.projectId, limit: 25 }),
          pendingCertificates(businessId, { projectId: resolved.projectId, limit: 25 }),
          certifiedClaimsAwaitingPayment(businessId, { projectId: resolved.projectId, limit: 25 }),
          expiringSecurities(businessId, { projectId: resolved.projectId, withinDays, limit: 25 }),
        ]);
      } catch (err) {
        if (err instanceof AecError && err.code === "capability_disabled") {
          return {
            ok: false,
            error:
              "چشم‌انداز تجاری پروژه روی این کسب‌وکار روشن نیست؛ برای دیدن آن، از «تنظیمات ← کسب‌وکار» قابلیت مالی پروژه (financials) را روشن کنید.",
          };
        }
        throw err;
      }

      // The answer separates what the workspace knows from what the books know.
      // A merged "margin" would be the single most misleading number this tool
      // could produce, so `accountingOwned` and `awaitingWaves` say what is not
      // here rather than leaving the model to assume zero.
      return {
        ok: true,
        data: {
          project: { id: summary.projectId, name: summary.projectName },
          contract: {
            originalRial: summary.originalContractRial,
            approvedVariationsRial: summary.approvedVariationsRial,
            revisedRial: summary.revisedContractRial,
            certifiedRial: summary.certifiedRial,
            remainingCommitmentRial: summary.remainingCommitmentRial,
            retentionReceivableRial: summary.retentionReceivableRial,
            retentionPayableRial: summary.retentionPayableRial,
            advanceRial: summary.advanceRial,
            recoveredAdvanceRial: summary.advanceRecoveredRial,
            outstandingAdvanceRial: summary.outstandingAdvanceRial,
            budgetRial: summary.budgetRial,
            approvedEstimateRial: summary.approvedEstimateRial,
            actualCostRial: summary.actualCostRial,
            budgetVarianceRial: summary.budgetVarianceRial,
          },
          openChangeOrders: openChanges.map((row) => ({
            ...row,
            submittedDateJalali: null,
          })),
          waitingCertificates: waitingCertificates.map((row) => ({
            ...row,
            submittedDateJalali: row.submittedDate ? formatJalali(row.submittedDate) : null,
          })),
          certifiedAwaitingPayment: awaitingPayment.map((row) => ({
            ...row,
            certifiedDateJalali: formatJalali(row.certifiedDate),
          })),
          expiringSecurities: securities.map((row) => ({
            ...row,
            expiryJalali: formatJalali(row.guaranteeExpiry),
          })),
          accountingOwned: summary.readInAccounting,
          awaitingWaves: summary.awaitingWaves,
          today,
          note:
            "این فهرست «ریسک» است نه ترازنامه: تغییرات باز، صورت‌وضعیت‌های تأییدنشده، موارد تأییدشده‌ای که وصول آن‌ها را باید در حسابداری بررسی کنی، و ضمانت‌نامه‌های نزدیک به انقضا. هزینهٔ واقعی از اسناد حسابداری خوانده می‌شود و اگر در دسترس نباشد null است، نه صفر.",
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
  owner: WorkspaceOwner,
  industry: string | null,
): Promise<AecToolResult> {
  if (!isAecAiToolName(name)) return { ok: false, error: "ابزار ناشناخته." };
  if (industry !== "architecture_construction") {
    return {
      ok: false,
      error: "این ابزار فقط برای کسب‌وکارهای مهندسی عمران، معماری و پیمانکاری است.",
    };
  }
  return runTool(name, args, owner);
}
