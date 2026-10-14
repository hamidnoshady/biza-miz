"use client";

/**
 * «بینش» — the Reports page starting from questions (#761 §15): which
 * projects are at risk, where we overspend, which deadlines slip, who is
 * overloaded, which contracts need attention, which approvals are stuck.
 *
 * Every answer is a list of real records, each one a link into it — the
 * raw table below stays for the power user and the accountant.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { workspaceProjectHref, workspaceSectionHref } from "@/lib/app-routes";
import {
  PROJECT_HEALTH_LABELS,
  PROJECT_HEALTH_REASON_LABELS,
  type ProjectHealth,
  type ProjectHealthReason,
} from "@/lib/workspace-shared";
import { workspaceError } from "./workspace-ui";

interface Insights {
  atRisk: Array<{ projectId: string; name: string; health: ProjectHealth; reasons: ProjectHealthReason[] }>;
  overspending: Array<{ projectId: string; name: string; budgetRial: number; spentRial: number }> | null;
  slipping: Array<{ taskId: string; title: string; projectName: string; dueDate: string; daysLate: number }>;
  overloaded: Array<{ userId: string; fullName: string; openTasks: number; overdueTasks: number }>;
  contracts: Array<{ contractId: string; title: string; projectName: string | null; endDate: string; state: "expiring" | "lapsed" }>;
  bottlenecks: Array<{ approvalId: string; title: string; projectName: string | null; approverName: string | null; ageDays: number }>;
}

const n = (value: number) => toPersianDigits(String(value));

export function InsightsPanel() {
  const money = useMoney();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ insights?: Insights; error?: string }>("/api/workspace/insights").then(({ ok, data }) => {
      if (ok && data.insights) setInsights(data.insights);
      else setError(workspaceError(data.error));
    });
  }, []);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!insights) return <InsightsPanelSkeleton />;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Question title="کدام پروژه‌ها در معرض خطرند؟" empty="همهٔ پروژه‌ها طبق برنامه‌اند.">
        {insights.atRisk.map((item) => (
          <Row key={item.projectId} href={workspaceProjectHref(item.projectId)} title={item.name}>
            {PROJECT_HEALTH_LABELS[item.health]} —{" "}
            {item.reasons.map((reason) => PROJECT_HEALTH_REASON_LABELS[reason]).join("، ")}
          </Row>
        ))}
      </Question>

      {insights.overspending ? (
        <Question title="کجا بیش از بودجه هزینه کرده‌ایم؟" empty="هیچ پروژه‌ای از بودجه‌اش جلو نزده است.">
          {insights.overspending.map((item) => (
            <Row key={item.projectId} href={workspaceProjectHref(item.projectId)} title={item.name}>
              {money.format(item.spentRial)} از {money.format(item.budgetRial)} —{" "}
              {money.format(item.spentRial - item.budgetRial)} بیش از بودجه
            </Row>
          ))}
        </Question>
      ) : null}

      <Question title="کدام مهلت‌ها از دست رفته‌اند؟" empty="وظیفهٔ عقب‌افتاده‌ای نیست.">
        {insights.slipping.map((item) => (
          <Row
            key={item.taskId}
            href={`${workspaceSectionHref("tasks")}?open=${item.taskId}`}
            title={item.title}
          >
            {item.projectName} — مهلت {formatJalali(item.dueDate)}، {n(item.daysLate)} روز تأخیر
          </Row>
        ))}
      </Question>

      <Question title="چه کسی بیش از حد کار دارد؟" empty="وظیفهٔ بازی به کسی واگذار نشده است.">
        {insights.overloaded.map((item) => (
          <Row key={item.userId} href={`${workspaceSectionHref("teams")}`} title={item.fullName}>
            {n(item.openTasks)} وظیفهٔ باز
            {item.overdueTasks ? `، ${n(item.overdueTasks)} عقب‌افتاده` : ""}
          </Row>
        ))}
      </Question>

      <Question title="کدام قراردادها نیاز به توجه دارند؟" empty="قراردادی رو به انقضا نیست.">
        {insights.contracts.map((item) => (
          <Row
            key={item.contractId}
            href={`${workspaceSectionHref("contracts")}?open=${item.contractId}`}
            title={item.title}
          >
            {item.state === "lapsed" ? "از پایان گذشته ولی بسته نشده" : "رو به انقضا"} —{" "}
            {formatJalali(item.endDate)}
            {item.projectName ? ` · ${item.projectName}` : ""}
          </Row>
        ))}
      </Question>

      <Question title="کدام تأییدها گلوگاه شده‌اند؟" empty="تأییدی در انتظار نیست.">
        {insights.bottlenecks.map((item) => (
          <Row key={item.approvalId} href={workspaceSectionHref("approvals")} title={item.title}>
            {n(item.ageDays)} روز در انتظار
            {item.approverName ? ` · ${item.approverName}` : " · بدون تأییدکنندهٔ مشخص"}
            {item.projectName ? ` · ${item.projectName}` : ""}
          </Row>
        ))}
      </Question>
    </div>
  );
}

export function InsightsPanelSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCardSkeleton rows={3} label="در حال بارگذاری بینش‌ها" />
      <SectionCardSkeleton rows={3} label="در حال بارگذاری بینش‌ها" />
    </div>
  );
}

function Question({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <SectionCard title={title} flush>
      {children.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/80">{children}</ul>
      )}
    </SectionCard>
  );
}

function Row({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 flex-col gap-0.5 px-4 py-2 text-sm hover:bg-muted/40">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </Link>
    </li>
  );
}
