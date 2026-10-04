"use client";

/**
 * One project's page.
 *
 * Everything about a project on one screen, behind tabs rather than on one
 * endless scroll: #761's Project Cockpit — the page's own summary, the work,
 * the files, the money, the people, what happened and the assistant panels the
 * project already had before Phase G, untouched and still talking to
 * `/api/ai/projects/**`.
 *
 * The section components here are the *same* ones the module's sections render,
 * given a `projectId`. A project's task list and the workspace task list are
 * one screen with one filter, not two implementations that drift.
 *
 * Issue #799 §21 layers the AEC registers on top of that bar rather than
 * replacing it: `aecProjectTabs` adds «طرف‌های پروژه», «متره و برآورد» and
 * §10–§14's registers as extra tabs for a business whose capabilities include
 * them, and an AEC project's identity card opens the «نمای کلی» tab. A non-AEC
 * tenant gets the same call with `null` and the same bar it always had.
 */

import { TemplateApplier } from "../../template-applier";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, FolderIcon, PencilIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  TabBar,
  TabPanel,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { FilterChip } from "@/app/dashboard/filters";
import { useMoney } from "@/components/money/money-context";
import { WORKSPACE_MODULE_HOME } from "@/lib/app-routes";
import { toPersianDigits } from "@/lib/digits";
import { aecProjectTabs, type ProjectTab } from "@/lib/aec-cockpit";
import {
  PHASE_STATUS_LABELS,
  PROJECT_HEALTH_LABELS,
  PROJECT_HEALTH_REASON_LABELS,
  type ProjectHealth,
  type ProjectHealthReason,
  WORKSPACE_ROLE_LABELS,
  completionPercent,
  type WorkspacePriority,
  type WorkspaceProjectCapabilities,
  type WorkspaceProjectStatus,
  type WorkspaceRole,
} from "@/lib/workspace-shared";
import {
  DateCell,
  PriorityBadge,
  ProgressBar,
  ProjectStatusBadge,
  TagList,
  workspaceError,
} from "../../workspace-ui";
import { useWorkspaceLookups } from "../../use-workspace-lookups";
import { TasksSection } from "../../tasks-section";
import { DocumentsSection } from "../../documents-section";
import { ContractsSection } from "../../contracts-section";
import { TeamsSection } from "../../teams-section";
import { ApprovalsSection } from "../../approvals-section";
import { CalendarSection } from "../../calendar-section";
import { ProjectAssistantPanels } from "./project-assistant-panels";
import { AecParticipantsTab, AecProjectProfileCard } from "./aec-panels";
import { BoqTab } from "./boq-panel";
import { AecDocumentsTab } from "./documents-panel";
import { AecRfisTab } from "./rfis-panel";
import { AecSubmittalsTab } from "./submittals-panel";
import { AecSiteTab } from "./site-panel";
import { AecInspectionsTab } from "./inspections-panel";
import { AecProcurementTab } from "./procurement-panel";
import { AecVariationsTab } from "./variations-panel";
import { AecCertificatesTab } from "./certificates-panel";
import { AecCommercialCard } from "./commercial-panel";

interface ProjectDetail {
  id: string;
  name: string;
  description: string;
  status: WorkspaceProjectStatus;
  priority: WorkspacePriority;
  projectType: string | null;
  startDate: string | null;
  endDate: string | null;
  tags: string[];
  partyId: string | null;
  partyName: string | null;
  ownerName: string | null;
  budgetRial: number | null;
  archivedAt: string | null;
  taskCount: number;
  doneTaskCount: number;
  memberCount: number;
  contractCount: number;
  documentCount: number;
}

interface Phase {
  id: string;
  name: string;
  status: "pending" | "active" | "done" | "skipped";
  displayOrder: number;
  startDate: string | null;
  endDate: string | null;
  taskCount: number;
  doneTaskCount: number;
}

interface Member {
  id: string;
  userId: string;
  fullName: string;
  role: WorkspaceRole;
}

interface Activity {
  id: string;
  subjectType: string;
  action: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

interface Attention {
  overdueTasks: number;
  pendingApprovals: number;
  expiringContracts: number;
  spentRial: number | null;
  contractValueRial: number;
}

interface Health {
  health: ProjectHealth;
  reasons: ProjectHealthReason[];
  elapsedPercent: number | null;
  progressPercent: number;
}

/**
 * Controls render from the server's `capabilities` — platform permission AND
 * project role — so a viewer gets a read-only page instead of forms that end
 * in a predictable 403. The server re-checks every write regardless.
 *
 * The AEC panels take the same flags, one level finer: their writes are gated
 * on the *manage* project capability and their approvals on
 * `workspace.approve`, which is what the AEC routes themselves require.
 */
export function ProjectDetail({ projectId }: { projectId: string }) {
  const money = useMoney();
  const lookups = useWorkspaceLookups();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  const [capabilities, setCapabilities] = useState<WorkspaceProjectCapabilities | null>(null);
  const [attention, setAttention] = useState<Attention | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<ProjectTab["key"]>("overview");

  const load = useCallback(() => {
    api<{
      project: ProjectDetail;
      phases: Phase[];
      members: Member[];
      activity: Activity[];
      role: WorkspaceRole;
      capabilities: WorkspaceProjectCapabilities;
      attention: Attention;
      health: Health;
    }>(`/api/workspace/projects/${projectId}`).then(({ ok, data }) => {
      setLoaded(true);
      if (ok) {
        setProject(data.project);
        setPhases(data.phases);
        setMembers(data.members);
        setActivity(data.activity);
        setRole(data.role);
        setCapabilities(data.capabilities);
        setAttention(data.attention);
        setHealth(data.health);
      } else {
        setError(workspaceError((data as unknown as { error?: string }).error));
      }
    });
  }, [projectId]);

  useEffect(load, [load]);

  const canContribute = capabilities?.canContribute ?? false;
  const canEdit = capabilities?.canEdit ?? false;
  const canManageProject = capabilities?.canManageProject ?? false;
  const canManageContracts = capabilities?.canManageContracts ?? false;
  const canApprove = capabilities?.canApprove ?? false;
  const canIssueDocuments = capabilities?.canIssueDocuments ?? false;

  // Issue #799 §21 — the cockpit. For an AEC tenant the bar gains the registers
  // its capabilities allow and the documents tab takes §9's name; for every
  // other tenant `aecProjectTabs(null)` returns exactly the bar this page had,
  // so nothing about the other nine industries changes.
  const tabs = aecProjectTabs(
    lookups.aecCapabilities ? { capabilities: lookups.aecCapabilities } : null,
  );

  if (!loaded) return <SectionCardSkeleton rows={6} label="در حال بارگذاری پروژه" />;

  if (!project) {
    return (
      <div className="flex flex-col gap-4">
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <EmptyState
          icon={FolderIcon}
          title="این پروژه در دسترس نیست"
          action={
            <Link href={`${WORKSPACE_MODULE_HOME}/projects`}>
              <PrimaryButton type="button">بازگشت به فهرست پروژه‌ها</PrimaryButton>
            </Link>
          }
        >
          یا حذف شده است، یا عضو آن نیستید.
        </EmptyState>
      </div>
    );
  }

  const percent = completionPercent(project.doneTaskCount, project.taskCount);

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectStatusBadge status={project.status} />
          <PriorityBadge priority={project.priority} />
          {role ? (
            <StatusBadge tone="neutral">نقش شما: {WORKSPACE_ROLE_LABELS[role]}</StatusBadge>
          ) : null}
          {project.archivedAt ? <StatusBadge tone="neutral">بایگانی‌شده</StatusBadge> : null}
          {health ? (
            <StatusBadge
              tone={health.health === "on_track" ? "positive" : health.health === "at_risk" ? "active" : "danger"}
              dot
            >
              {PROJECT_HEALTH_LABELS[health.health]}
            </StatusBadge>
          ) : null}
        </div>
        <Link href={`${WORKSPACE_MODULE_HOME}/projects`}>
          <SecondaryButton>
            <ArrowRightIcon className="size-4 rtl:rotate-180" aria-hidden />
            همهٔ پروژه‌ها
          </SecondaryButton>
        </Link>
      </div>

      {attention && health ? (
        <AttentionStrip attention={attention} health={health} onOpen={(next) => setTab(next)} />
      ) : null}

      <KpiRow>
        <KpiCard
          label="پیشرفت وظایف"
          value={`${toPersianDigits(String(percent))}٪`}
          hint={`${toPersianDigits(String(project.doneTaskCount))} از ${toPersianDigits(String(project.taskCount))}`}
        />
        <KpiCard
          label="بودجه"
          value={project.budgetRial === null ? "—" : money.format(project.budgetRial)}
          hint="هزینهٔ ثبت‌شده در گزارش‌ها"
        />
        <KpiCard label="قراردادها" value={toPersianDigits(String(project.contractCount))} />
        <KpiCard label="اسناد" value={toPersianDigits(String(project.documentCount))} />
      </KpiRow>

      <TabBar
        idPrefix="workspace-project"
        label="بخش‌های پروژه"
        tabs={tabs}
        active={tab}
        onChange={setTab}
      />

      <TabPanel idPrefix="workspace-project" active={tab}>
        {tab === "overview" ? (
        <div className="flex flex-col gap-4">
          {/* Issue #799 §21 — what this project *is* for the industry: its type,
              its specialties, the client's requirements, the site. Rendered at
              the top of the overview because that is the section the cockpit
              gives it; an AEC business whose project has no profile yet gets the
              form, everyone else never sees the card. */}
          {lookups.aecCapabilities ? (
            <AecProjectProfileCard
              projectId={projectId}
              canManage={canManageProject}
              lookups={lookups}
            />
          ) : null}

          <SectionCard title="پروندهٔ پروژه" description={project.description || undefined}>
            <dl className="grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="مشتری / طرف حساب" value={project.partyName ?? "—"} />
              <Fact label="مالک" value={project.ownerName ?? "—"} />
              <Fact label="نوع پروژه" value={project.projectType || "—"} />
              <Fact
                label="شروع"
                value={<DateCell date={project.startDate} relative={false} />}
              />
              <Fact label="پایان" value={<DateCell date={project.endDate} />} />
              <Fact
                label="اعضا"
                value={
                  members.length
                    ? members.map((member) => member.fullName).join("، ")
                    : `${toPersianDigits(String(project.memberCount))} نفر`
                }
              />
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-xs text-muted-foreground">برچسب‌ها</dt>
                <dd className="mt-1">
                  {project.tags.length ? (
                    <TagList tags={project.tags} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-xs text-muted-foreground">پیشرفت</dt>
                <dd className="mt-1">
                  <ProgressBar percent={percent} label={`پیشرفت ${project.name}`} />
                </dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard
            title="فازها"
            description="فازها از قالب پروژه ساخته می‌شوند و وظایف به آن‌ها وصل می‌شوند."
            flush
          >
            {phases.length === 0 ? (
              <EmptyState icon={FolderIcon} title="فازی تعریف نشده است">
                {canManageProject
                  ? "یک قالب را در پایین همین کارت پیش‌نمایش و اعمال کنید."
                  : "مدیر پروژه می‌تواند یک قالب فازبندی روی آن اعمال کند."}
              </EmptyState>
            ) : (
              <ol className="divide-y divide-border/80">
                {phases.map((phase, index) => (
                  <li key={phase.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                    <span className="tabular-nums text-muted-foreground">
                      {toPersianDigits(String(index + 1))}
                    </span>
                    <span className="min-w-0 flex-1 font-medium">{phase.name}</span>
                    <StatusBadge
                      tone={
                        phase.status === "active"
                          ? "active"
                          : phase.status === "done"
                            ? "positive"
                            : "neutral"
                      }
                    >
                      {PHASE_STATUS_LABELS[phase.status]}
                    </StatusBadge>
                    <span className="text-xs text-muted-foreground">
                      {toPersianDigits(String(phase.doneTaskCount))}/
                      {toPersianDigits(String(phase.taskCount))} وظیفه
                    </span>
                    <DateCell date={phase.endDate} className="text-xs" />
                  </li>
                ))}
              </ol>
            )}
            {canManageProject ? <TemplateApplier projectId={projectId} onApplied={load} /> : null}
          </SectionCard>

        </div>
        ) : null}

        {tab === "work" ? (
          <div className="flex flex-col gap-4">
          <TasksSection
            lookups={lookups}
            canManage={canEdit}
            canContribute={canContribute}
            projectId={projectId}
          />
          <CalendarSection lookups={lookups} canManage={canContribute} projectId={projectId} />
          </div>
        ) : null}

        {/* Issue #799 §9 — the drawing register. For an AEC business with
            document control the tab opens with the register and the
            transmittals, and the ordinary document list follows underneath:
            the register *references* documents rather than replacing them, so
            files that are not drawings still have their own screen here.
            `document_control` is what decides — an office whose profile leaves
            it off sees exactly the documents tab it had before. */}
        {tab === "files" ? (
          <div className="flex flex-col gap-4">
            {lookups.aecCapabilities?.includes("document_control") ? (
              <AecDocumentsTab
                projectId={projectId}
                canManage={canManageProject}
                canIssueDocuments={canIssueDocuments}
                lookups={lookups}
              />
            ) : null}
            <DocumentsSection
              lookups={lookups}
              canManage={canEdit}
              canRequestApproval={canContribute}
              projectId={projectId}
            />
          </div>
        ) : null}

        {/* A contract has one nullable `project_id`, so a project's tab shows
            exactly that project's contracts — never the whole register.

            Issue #799 §7 — the project's priced work sits above them, in §21's
            order (what is being built, what it costs, then who is bound).
            Mounted only when the capability is on, which is also what puts the
            tab in the bar: an office that does not estimate neither sees the
            tab nor mounts the component that would fetch its data. */}
        {tab === "finance" ? (
          <div className="flex flex-col gap-4">
          <FinanceCard project={project} attention={attention} />
          {lookups.aecCapabilities?.includes("boq") ? (
            <BoqTab
              projectId={projectId}
              canManage={canManageProject}
              canApprove={canApprove}
              lookups={lookups}
            />
          ) : null}
          <ContractsSection
            lookups={lookups}
            canManageContracts={canManageContracts}
            canRequestApproval={canContribute}
            projectId={projectId}
          />
          {/* Issue #799 §20 — the commercial cockpit, and §17's AEC block on
              each of the project's contracts. It is in the finance tab rather
              than a tab of its own because it is the money tab's own summary,
              and `financials` is what mounts it: a design office that has the
              cockpit switched off never fetches it. */}
          {lookups.aecCapabilities?.includes("financials") ? (
            <AecCommercialCard
              projectId={projectId}
              canManage={canManageProject}
              lookups={lookups}
            />
          ) : null}
          </div>
        ) : null}

        {/* Issue #799 §7 — the estimating tab for a business that prices work.
            It is in the bar only when `boq` is on, so a design office never
            lands here; the tab is its own because a BOQ is a document a
            quantity surveyor works in, not a card on a finance page. */}
        {tab === "boq" ? (
          <BoqTab
            projectId={projectId}
            canManage={canManageProject}
            canApprove={canApprove}
            lookups={lookups}
          />
        ) : null}

        {tab === "participants" ? (
          <AecParticipantsTab projectId={projectId} canManage={canManageProject} lookups={lookups} />
        ) : null}

        {/* Issue #799 §10 — the RFI register. Every AEC shape has it (an RFI is
            a question asked of a client, not a capability), so the tab exists
            wherever the business is AEC at all. */}
        {tab === "rfis" ? (
          <AecRfisTab projectId={projectId} canManage={canManageProject} lookups={lookups} />
        ) : null}

        {/* Issue #799 §11 — the submittal log, gated by `document_control` in
            the tab bar itself: it is a document cycle pointing at §9's register,
            and reviewing is `workspace.approve`, not ordinary edit rights. */}
        {tab === "submittals" ? (
          <AecSubmittalsTab
            projectId={projectId}
            canManage={canManageProject}
            canApprove={canApprove}
            lookups={lookups}
          />
        ) : null}

        {/* Issue #799 §13 — the site diary: the day-by-day record, gated by
            `site_operations` in the tab bar, with its own «روزنگار» view that
            merges the days with §14's quality register. */}
        {tab === "site" ? (
          <AecSiteTab projectId={projectId} canManage={canManageProject} lookups={lookups} />
        ) : null}

        {/* Issue #799 §14 — inspections, NCRs, snags, HSE observations and
            handover items in one register, gated by `qa_qc`. Closing one is the
            closeout verification, so it needs `workspace.approve` — and the
            service refuses to let the assignee verify their own fix. */}
        {tab === "inspections" ? (
          <AecInspectionsTab
            projectId={projectId}
            canManage={canManageProject}
            canApprove={canApprove}
            lookups={lookups}
          />
        ) : null}

        {/* Issue #799 §18 — procurement: the material requests, the RFQs with
            their comparison sheet, the purchase/subcontract commitments and
            their deliveries. `procurement` is what puts the tab in the bar, so
            an architecture office that switched the register off never mounts
            it; a subcontract award additionally needs `subcontractors`, which
            the API enforces rather than this page. Granting a request and
            obliging the business to an award are §24 determinations and need
            `workspace.approve`. */}
        {tab === "procurement" ? (
          <AecProcurementTab
            projectId={projectId}
            canManage={canManageProject}
            canApprove={canApprove}
            lookups={lookups}
          />
        ) : null}

        {/* Issue #799 §15 — the change-order register. `variations` is what puts
            the tab in the bar, so a business that does not raise change orders
            never mounts it. Approving, rejecting, implementing and cancelling a
            change are §24 determinations and need `workspace.approve`. */}
        {tab === "changes" ? (
          <AecVariationsTab
            projectId={projectId}
            canManage={canManageProject}
            canApprove={canApprove}
            lookups={lookups}
          />
        ) : null}

        {/* Issue #799 §16 — progress measurement and payment certificates, both
            directions: our application to the client and the certificate we
            issue to a contractor. Certified is not collected — receipts stay in
            Accounting. */}
        {tab === "payments" ? (
          <AecCertificatesTab
            projectId={projectId}
            canManage={canManageProject}
            canApprove={canApprove}
            lookups={lookups}
          />
        ) : null}

        {tab === "team" ? (
          <TeamsSection lookups={lookups} canManage={canManageProject} projectId={projectId} />
        ) : null}

        {tab === "activity" ? (
          <div className="flex flex-col gap-4">
          <ApprovalsSection canApprove={canApprove} projectId={projectId} />
          <SectionCard title="رویدادهای اخیر" description="آنچه روی این پروژه انجام شده است" flush>
            {activity.length === 0 ? (
              <EmptyState icon={PencilIcon} title="هنوز رویدادی ثبت نشده است">
                هر تغییری روی پروژه، وظایف، اسناد و قراردادهای آن اینجا ثبت می‌شود.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border/80">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline gap-2 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">{entry.summary}</span>
                    <span className="text-xs text-muted-foreground">{entry.actorName}</span>
                    <DateCell date={entry.createdAt.slice(0, 10)} className="text-xs" />
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          </div>
        ) : null}

        {tab === "assistant" ? <ProjectAssistantPanels projectId={projectId} /> : null}
      </TabPanel>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

/**
 * What needs attention on this project right now (#761 §8) — each item a
 * real count from the server, each one a way into the tab that resolves it.
 */
function AttentionStrip({
  attention,
  health,
  onOpen,
}: {
  attention: Attention;
  health: Health;
  onOpen: (tab: ProjectTab["key"]) => void;
}) {
  const items: Array<{ key: string; label: string; tab: ProjectTab["key"] }> = [];
  const n = (value: number) => toPersianDigits(String(value));
  if (attention.overdueTasks) items.push({ key: "overdue", label: `${n(attention.overdueTasks)} وظیفهٔ عقب‌افتاده`, tab: "work" });
  if (attention.pendingApprovals) items.push({ key: "approvals", label: `${n(attention.pendingApprovals)} تأیید در انتظار`, tab: "activity" });
  if (attention.expiringContracts) items.push({ key: "contracts", label: `${n(attention.expiringContracts)} قرارداد رو به انقضا`, tab: "finance" });
  for (const reason of health.reasons) {
    if (reason === "over_budget" || reason === "budget_nearly_spent") {
      items.push({ key: reason, label: PROJECT_HEALTH_REASON_LABELS[reason], tab: "finance" });
    } else if (reason === "behind_schedule" || reason === "past_deadline") {
      items.push({ key: reason, label: PROJECT_HEALTH_REASON_LABELS[reason], tab: "work" });
    }
  }
  if (!items.length) return null;
  return (
    <div role="region" aria-label="نیازمند توجه" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-muted-foreground">نیازمند توجه:</span>
      {items.map((item) => (
        <FilterChip key={item.key} selected={false} onClick={() => onOpen(item.tab)}>
          {item.label}
        </FilterChip>
      ))}
    </div>
  );
}

/**
 * Budget against posted spend and committed contracts. Labelled «مانده از
 * بودجه», never «سود»: budget minus spend is not profit unless revenue is
 * booked against the project (#761 §8).
 */
function FinanceCard({ project, attention }: { project: ProjectDetail; attention: Attention | null }) {
  const money = useMoney();
  const spent = attention?.spentRial ?? null;
  const remaining = project.budgetRial !== null && spent !== null ? project.budgetRial - spent : null;
  return (
    <KpiRow>
      <KpiCard label="بودجه" value={project.budgetRial === null ? "—" : money.format(project.budgetRial)} />
      <KpiCard
        label="هزینهٔ ثبت‌شده"
        value={spent === null ? "—" : money.format(spent)}
        hint={spent === null ? "نیازمند دسترسی به دفاتر حسابداری" : "از اسناد حسابداری همین پروژه"}
      />
      <KpiCard label="مانده از بودجه" value={remaining === null ? "—" : money.format(remaining)} />
      <KpiCard
        label="ارزش قراردادها"
        value={money.format(attention?.contractValueRial ?? 0)}
        hint="فعال و انجام‌شده"
      />
    </KpiRow>
  );
}
