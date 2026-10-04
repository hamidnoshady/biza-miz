"use client";

/**
 * The projects list as a portfolio (#761 §7): cards for scanning, a timeline
 * for seeing where every project sits in time. The table stays as the third
 * view for the power user. Health is `projectHealth` — the same pure verdict
 * the cockpit shows — from counts the list row already carries; budget is
 * judged on the project page, where the ledger figure is read.
 */

import Link from "next/link";
import { AlertTriangleIcon, UsersIcon } from "lucide-react";
import { StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { workspaceProjectHref } from "@/lib/app-routes";
import { cn } from "@/lib/utils";
import {
  PROJECT_HEALTH_LABELS,
  PROJECT_HEALTH_REASON_LABELS,
  daysUntil,
  projectHealth,
  type ProjectHealth,
} from "@/lib/workspace-shared";
import { DateCell, PriorityBadge, ProgressBar, ProjectStatusBadge } from "./workspace-ui";
import type { ProjectRow } from "./projects-section";

const HEALTH_TONE: Record<ProjectHealth, "positive" | "active" | "danger"> = {
  on_track: "positive",
  at_risk: "active",
  off_track: "danger",
};

/** Pure: the list row's health verdict, without the ledger (judged on the project page). */
export function rowHealth(project: ProjectRow, today: string) {
  return projectHealth({
    today,
    startDate: project.startDate,
    endDate: project.endDate,
    completed: project.status === "completed",
    taskCount: project.taskCount,
    doneTaskCount: project.doneTaskCount,
    overdueTaskCount: project.overdueTaskCount,
    budgetRial: project.budgetRial,
    spentRial: null,
    pendingApprovals: project.openApprovalCount,
    expiringContracts: 0,
  });
}

export function ProjectCards({ projects, today }: { projects: ProjectRow[]; today: string }) {
  const money = useMoney();
  return (
    <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => {
        const health = rowHealth(project, today);
        const warnings = project.overdueTaskCount + project.openApprovalCount;
        return (
          <li key={project.id} className={cn(cardClass, "flex flex-col gap-3 p-4")}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link
                  href={workspaceProjectHref(project.id)}
                  className="block truncate font-semibold underline-offset-4 hover:underline"
                >
                  {project.name}
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {[project.partyName, project.projectType].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
              <PriorityBadge priority={project.priority} />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <ProjectStatusBadge status={project.status} />
              <StatusBadge tone={HEALTH_TONE[health.health]} dot>
                {PROJECT_HEALTH_LABELS[health.health]}
              </StatusBadge>
            </div>
            {health.reasons.length ? (
              <p className="text-xs text-muted-foreground">
                {health.reasons.map((reason) => PROJECT_HEALTH_REASON_LABELS[reason]).join("، ")}
              </p>
            ) : null}

            <ProgressBar percent={health.progressPercent} label={`پیشرفت ${project.name}`} />
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">وظایف</dt>
              <dd className="tabular-nums">
                {toPersianDigits(String(project.doneTaskCount))}/{toPersianDigits(String(project.taskCount))}
              </dd>
              <dt className="text-muted-foreground">مهلت</dt>
              <dd>
                <DateCell date={project.endDate} className="text-xs" />
              </dd>
              <dt className="text-muted-foreground">بودجه</dt>
              <dd className="tabular-nums">
                {project.budgetRial === null ? "—" : money.format(project.budgetRial)}
              </dd>
            </dl>

            <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <UsersIcon className="size-3.5" aria-hidden />
                {toPersianDigits(String(project.memberCount))} نفر
              </span>
              {warnings ? (
                <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300">
                  <AlertTriangleIcon className="size-3.5" aria-hidden />
                  {toPersianDigits(String(warnings))} هشدار
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A horizontal schedule: each project a bar from its start to its end, on one
 * shared scale across the projects shown, with a "today" line. Wide by
 * nature, so it scrolls inside its own box — never the page.
 */
export function ProjectTimeline({ projects, today }: { projects: ProjectRow[]; today: string }) {
  const dated = projects.filter((p) => p.startDate && p.endDate);
  if (!dated.length) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        برای دیدن خط زمانی، به پروژه‌ها تاریخ شروع و پایان بدهید.
      </p>
    );
  }
  const from = dated.reduce((min, p) => (p.startDate! < min ? p.startDate! : min), dated[0].startDate!);
  const to = dated.reduce((max, p) => (p.endDate! > max ? p.endDate! : max), dated[0].endDate!);
  const span = Math.max(1, daysUntil(to, from));
  const pos = (date: string) => Math.min(100, Math.max(0, (daysUntil(date, from) / span) * 100));
  const todayPos = today >= from && today <= to ? pos(today) : null;

  return (
    <div className="overflow-x-auto p-4">
      <div className="min-w-[640px]">
        <div className="mb-2 flex justify-between text-xs text-muted-foreground">
          <span>{formatJalali(from)}</span>
          <span>{formatJalali(to)}</span>
        </div>
        <ol className="relative flex flex-col gap-2">
          {todayPos !== null ? (
            <li
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-rose-500/70"
              style={{ insetInlineStart: `${todayPos}%` }}
            />
          ) : null}
          {dated.map((project) => {
            const health = rowHealth(project, today);
            const start = pos(project.startDate!);
            const width = Math.max(1.5, pos(project.endDate!) - start);
            return (
              <li key={project.id} className="flex items-center gap-3">
                <Link
                  href={workspaceProjectHref(project.id)}
                  className="w-40 shrink-0 truncate text-sm font-medium underline-offset-4 hover:underline"
                >
                  {project.name}
                </Link>
                <div className="relative h-6 flex-1 rounded bg-muted/40">
                  <div
                    className={cn(
                      "absolute inset-y-0 overflow-hidden rounded",
                      health.health === "off_track"
                        ? "bg-rose-200 dark:bg-rose-500/30"
                        : health.health === "at_risk"
                          ? "bg-amber-200 dark:bg-amber-500/30"
                          : "bg-emerald-200 dark:bg-emerald-500/30",
                    )}
                    style={{ insetInlineStart: `${start}%`, width: `${width}%` }}
                    title={`${formatJalali(project.startDate!)} تا ${formatJalali(project.endDate!)} — ${PROJECT_HEALTH_LABELS[health.health]}`}
                  >
                    {/* Done share of the bar — progress against its own span. */}
                    <div
                      className="h-full bg-foreground/15"
                      style={{ width: `${health.progressPercent}%` }}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
