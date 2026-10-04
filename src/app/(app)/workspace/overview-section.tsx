"use client";

/**
 * «نمای کلی» — the workspace dashboard.
 *
 * Answers one question on open: what needs me today. The four headline
 * counters are the brief's (فعال / امروز / تأیید / مهلت), and everything below
 * them is a short list rather than a full section — the sections themselves are
 * one click away in the rail, so repeating them here would be two places to
 * maintain the same table.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  BriefcaseIcon,
  CalendarClockIcon,
  CheckSquareIcon,
  FileSignatureIcon,
  ShieldCheckIcon,
} from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  KpiRowSkeleton,
  SectionCard,
  SectionCardSkeleton,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, SecondaryButton } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { workspaceProjectHref, workspaceSectionHref } from "@/lib/app-routes";
import { CALENDAR_SOURCE_LABELS } from "@/lib/workspace-shared";
import { DateCell, PriorityBadge, TaskStatusBadge, workspaceError } from "./workspace-ui";

interface DashboardTask {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: "open" | "in_progress" | "blocked" | "done";
  priority: "low" | "normal" | "high" | "urgent";
  dueDate: string | null;
}

interface DashboardEntry {
  id: string;
  source: keyof typeof CALENDAR_SOURCE_LABELS;
  title: string;
  date: string;
  projectId: string | null;
  projectName: string | null;
}

interface DashboardApproval {
  id: string;
  subjectTitle: string;
  subjectType: "project" | "task" | "document" | "contract";
  dueDate: string | null;
  requestedByName: string | null;
}

interface DashboardActivity {
  id: string;
  summary: string;
  action: string;
  subjectType: string;
  actorName: string;
  projectName: string | null;
  createdAt: string;
}

interface Dashboard {
  activeProjects: number;
  tasksToday: number;
  myOpenTasks: number;
  pendingApprovals: number;
  upcomingDeadlines: number;
  overdueTasks: number;
  expiringContracts: number;
  myTasks: DashboardTask[];
  deadlines: DashboardEntry[];
  approvals: DashboardApproval[];
  activity: DashboardActivity[];
}

const ACTION_LABELS: Record<string, string> = {
  created: "ایجاد شد",
  updated: "به‌روزرسانی شد",
  revised: "نسخهٔ تازه ثبت شد",
  requested: "درخواست تأیید ثبت شد",
  approved: "تأیید شد",
  rejected: "رد شد",
  cancelled: "لغو شد",
  member_set: "عضو تعیین شد",
  status_done: "انجام شد",
  status_in_progress: "در حال انجام",
  status_blocked: "مسدود شد",
  status_open: "بازگشایی شد",
};

export function OverviewSection() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    api<{ dashboard: Dashboard }>("/api/workspace/dashboard").then(({ ok, data: body }) => {
      if (ok) setData(body.dashboard);
      else setError(workspaceError((body as unknown as { error?: string }).error));
    });
  }, []);

  useEffect(load, [load]);

  // A failed first load is an error with a retry, not an endless skeleton.
  if (!data && error) {
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorBox>{error}</ErrorBox>
        <SecondaryButton onClick={load}>تلاش دوباره</SecondaryButton>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <KpiRowSkeleton count={4} label="در حال آماده‌سازی خلاصهٔ میز کار" />
        <SectionCardSkeleton rows={4} />
        <SectionCardSkeleton rows={3} />
      </div>
    );
  }

  const n = (value: number) => toPersianDigits(String(value));

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard
          label="پروژه‌های فعال"
          value={n(data.activeProjects)}
          icon={BriefcaseIcon}
          hint="در حال اجرا"
        />
        <KpiCard
          label="وظایف امروز"
          value={n(data.tasksToday)}
          icon={CheckSquareIcon}
          hint={data.overdueTasks ? `${n(data.overdueTasks)} مورد عقب‌افتاده` : "بدون تأخیر"}
        />
        <KpiCard
          label="تأییدهای در انتظار"
          value={n(data.pendingApprovals)}
          icon={ShieldCheckIcon}
          hint="در صف تصمیم"
        />
        <KpiCard
          label="مهلت‌های پیش‌رو"
          value={n(data.upcomingDeadlines)}
          icon={CalendarClockIcon}
          hint="دو هفتهٔ آینده"
        />
      </KpiRow>

      {data.expiringContracts > 0 ? (
        <SectionCard
          title="قراردادهای نزدیک به انقضا"
          description={`${n(data.expiringContracts)} قرارداد در ۳۰ روز آینده منقضی می‌شود.`}
          actions={
            <Link
              href={`${workspaceSectionHref("contracts")}?expiring=30`}
              className="text-sm text-amber-800 underline-offset-4 hover:underline dark:text-amber-200"
            >
              مشاهدهٔ فهرست
            </Link>
          }
        >
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <FileSignatureIcon className="size-4 shrink-0" aria-hidden />
            <span>پیش از انقضا، تمدید یا خاتمهٔ هر قرارداد را ثبت کنید.</span>
          </div>
        </SectionCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="وظایف من"
          description="کارهای واگذارشده به شما که هنوز بسته نشده‌اند"
          actions={
            <Link
              href={`${workspaceSectionHref("tasks")}?mine=true`}
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              همه
            </Link>
          }
        >
          {data.myTasks.length === 0 ? (
            <EmptyState
              icon={CheckSquareIcon}
              title="وظیفهٔ بازی ندارید"
            >
              هر وظیفه‌ای که به شما واگذار شود اینجا دیده می‌شود.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/80">
              {data.myTasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <Link
                    href={workspaceProjectHref(task.projectId)}
                    className="min-w-0 flex-1 truncate font-medium underline-offset-4 hover:underline"
                  >
                    {task.title}
                  </Link>
                  <span className="truncate text-xs text-muted-foreground">{task.projectName}</span>
                  <PriorityBadge priority={task.priority} />
                  <TaskStatusBadge status={task.status} />
                  <DateCell date={task.dueDate} className="text-xs" />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="مهلت‌های پیش‌رو"
          description="مهلت پروژه‌ها و وظایف، جلسه‌ها، انقضای قرارداد و تأییدها"
          actions={
            <Link
              href={workspaceSectionHref("calendar")}
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              تقویم
            </Link>
          }
        >
          {data.deadlines.length === 0 ? (
            <EmptyState
              icon={CalendarClockIcon}
              title="مهلتی در پیش نیست"
            >
              تاریخ‌های ثبت‌شده در پروژه‌ها و قراردادها اینجا جمع می‌شوند.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/80">
              {data.deadlines.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {CALENDAR_SOURCE_LABELS[entry.source]}
                  </span>
                  <DateCell date={entry.date} className="text-xs" />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="تأییدهای در انتظار من"
          description="درخواست‌هایی که تصمیم شما را می‌خواهند"
          actions={
            <Link
              href={workspaceSectionHref("approvals")}
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              همه
            </Link>
          }
        >
          {data.approvals.length === 0 ? (
            <EmptyState
              icon={ShieldCheckIcon}
              title="درخواستی در انتظار نیست"
            >
              درخواست تأیید قرارداد و سند اینجا ظاهر می‌شود.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/80">
              {data.approvals.map((approval) => (
                <li key={approval.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{approval.subjectTitle}</span>
                  {approval.requestedByName ? (
                    <span className="text-xs text-muted-foreground">
                      درخواست: {approval.requestedByName}
                    </span>
                  ) : null}
                  <DateCell date={approval.dueDate} className="text-xs" />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="فعالیت اخیر" description="آنچه امروز در میز کار تغییر کرده است">
          {data.activity.length === 0 ? (
            <EmptyState
              icon={AlertTriangleIcon}
              title="هنوز فعالیتی ثبت نشده"
            >
              با ساخت نخستین پروژه، رویدادها اینجا ثبت می‌شوند.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/80">
              {data.activity.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5 text-sm">
                  <span className="font-medium">{entry.actorName}</span>
                  <span className="text-muted-foreground">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </span>
                  {entry.summary ? <span className="truncate">«{entry.summary}»</span> : null}
                  {entry.projectName ? (
                    <span className="text-xs text-muted-foreground">در {entry.projectName}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
