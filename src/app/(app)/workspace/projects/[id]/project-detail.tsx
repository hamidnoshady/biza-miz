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
import { useMoney } from "@/components/money/money-context";
import { WORKSPACE_MODULE_HOME } from "@/lib/app-routes";
import { toPersianDigits } from "@/lib/digits";
import {
  PHASE_STATUS_LABELS,
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

const TABS = [
  { key: "record", label: "پرونده" },
  { key: "tasks", label: "وظایف" },
  { key: "documents", label: "اسناد" },
  { key: "contracts", label: "قراردادها" },
  { key: "team", label: "تیم" },
  { key: "approvals", label: "تأییدها" },
  { key: "calendar", label: "تقویم" },
  { key: "assistant", label: "دستیار" },
] as const;

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
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<TabKey>("record");

  const load = useCallback(() => {
    api<{
      project: ProjectDetail;
      phases: Phase[];
      members: Member[];
      activity: Activity[];
      role: WorkspaceRole;
      capabilities: WorkspaceProjectCapabilities;
    }>(`/api/workspace/projects/${projectId}`).then(({ ok, data }) => {
      setLoaded(true);
      if (ok) {
        setProject(data.project);
        setPhases(data.phases);
        setMembers(data.members);
        setActivity(data.activity);
        setRole(data.role);
        setCapabilities(data.capabilities);
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
        </div>
        <Link href={`${WORKSPACE_MODULE_HOME}/projects`}>
          <SecondaryButton>
            <ArrowRightIcon className="size-4 rtl:rotate-180" aria-hidden />
            همهٔ پروژه‌ها
          </SecondaryButton>
        </Link>
      </div>

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
        {tab === "record" ? (
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

        {tab === "tasks" ? (
          <TasksSection lookups={lookups} canManage={canEdit} projectId={projectId} />
        ) : null}

        {tab === "documents" ? (
          <DocumentsSection
            lookups={lookups}
            canManage={canEdit}
            canRequestApproval={canContribute}
            projectId={projectId}
          />
        ) : null}

        {/* A contract has one nullable `project_id`, so a project's tab shows
            exactly that project's contracts — never the whole register. */}
        {tab === "contracts" ? (
          <ContractsSection
            lookups={lookups}
            canManageContracts={canManageContracts}
            canRequestApproval={canContribute}
            projectId={projectId}
          />
        ) : null}

        {tab === "team" ? (
          <TeamsSection lookups={lookups} canManage={canManageProject} projectId={projectId} />
        ) : null}

        {tab === "approvals" ? (
          <ApprovalsSection canApprove={canApprove} projectId={projectId} />
        ) : null}

        {tab === "calendar" ? (
          <CalendarSection lookups={lookups} canManage={canContribute} projectId={projectId} />
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
