"use client";

/**
 * One project's page.
 *
 * Everything about a project on one screen, behind tabs rather than on one
 * endless scroll: its record and phases, its tasks, its documents, its
 * execution contracts, its team, its approvals and its calendar — plus the
 * assistant panels the project already had before Phase G (instruction,
 * conversations, files, notes, memory), untouched and still talking to
 * `/api/ai/projects/**`.
 *
 * The section components here are the *same* ones the module's sections render,
 * given a `projectId`. A project's task list and the workspace task list are
 * one screen with one filter, not two implementations that drift.
 */

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

/**
 * The Project Cockpit (#761 §8): six tabs organised around how a project is
 * run rather than one tab per table — the work, its files, its money, its
 * people, and what happened.
 */
const TABS = [
  { key: "overview", label: "نمای کلی" },
  { key: "work", label: "کار" },
  { key: "files", label: "اسناد" },
  { key: "finance", label: "مالی" },
  { key: "team", label: "تیم" },
  { key: "activity", label: "رویدادها" },
  { key: "assistant", label: "دستیار" },
] as const;

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

type TabKey = (typeof TABS)[number]["key"];

/**
 * Controls render from the server's `capabilities` — platform permission AND
 * project role — so a viewer gets a read-only page instead of forms that end
 * in a predictable 403. The server re-checks every write regardless.
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
  const [tab, setTab] = useState<TabKey>("overview");

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
        <AttentionStrip attention={attention} health={health} onOpen={setTab} />
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
        tabs={TABS.map((item) => ({ key: item.key, label: item.label }))}
        active={tab}
        onChange={setTab}
      />

      <TabPanel idPrefix="workspace-project" active={tab}>
        {tab === "overview" ? (
        <div className="flex flex-col gap-4">
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
                می‌توانید از بخش «قالب‌ها» یک قالب فازبندی روی این پروژه اعمال کنید.
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

        {tab === "files" ? (
          <DocumentsSection
            lookups={lookups}
            canManage={canEdit}
            canRequestApproval={canContribute}
            projectId={projectId}
          />
        ) : null}

        {/* A contract has one nullable `project_id`, so a project's tab shows
            exactly that project's contracts — never the whole register. */}
        {tab === "finance" ? (
          <div className="flex flex-col gap-4">
          <FinanceCard project={project} attention={attention} />
          <ContractsSection
            lookups={lookups}
            canManageContracts={canManageContracts}
            canRequestApproval={canContribute}
            projectId={projectId}
          />
          </div>
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
  onOpen: (tab: TabKey) => void;
}) {
  const items: Array<{ key: string; label: string; tab: TabKey }> = [];
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
      <KpiCard label="ارزش قراردادهای فعال" value={money.format(attention?.contractValueRial ?? 0)} />
    </KpiRow>
  );
}
