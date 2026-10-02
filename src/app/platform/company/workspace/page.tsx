"use client";

import { useEffect, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { Button } from "@/components/ui/button";
import { api, ErrorBox } from "../../ui";
import { CompanyWorkspace } from "../_components/company-workspace";

interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  priority: string;
  projectType: string | null;
  partyName: string | null;
  startDate: string | null;
  endDate: string | null;
  budgetRial: number | null;
  forecastRevenueRial: number | null;
  sourceDealId: string | null;
  taskCount: number;
  doneTaskCount: number;
  memberCount: number;
  links: { linkKind: string; linkedId: string }[];
  postedActuals: null | { revenueRial: number; costRial: number };
}

const STATUS_LABELS: Record<string, string> = {
  planning: "برنامه‌ریزی",
  active: "در حال اجرا",
  on_hold: "متوقف",
  completed: "تکمیل‌شده",
  cancelled: "لغو شده",
};

const LINK_LABELS: Record<string, string> = {
  deal: "معامله",
  invoice: "صورتحساب",
  campaign: "کمپین",
  website: "وب‌سایت",
  support_ticket: "تیکت پشتیبانی",
  customer_tenant: "tenant مشتری",
};

/**
 * Platform Business My Workspace.
 *
 * The projects themselves are the shared engine's — this page never creates a
 * second project system. What it adds is the platform view: which project came
 * from which CRM deal, which customer tenant it serves, and an honest split
 * between the project's own plan figures (budget, forecast) and the actuals
 * Accounting has posted.
 *
 * Actuals appear only for a caller whose preset holds «مشاهدهٔ دفتر»; a project
 * manager sees what they manage without being handed the ledger.
 */
export default function Page() {
  const money = useMoney();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [actualsIncluded, setActualsIncluded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const result = await api<{ projects?: ProjectSummary[]; actualsIncluded?: boolean; error?: string }>(
        "/api/platform/company/workspace/projects",
      );
      if (result.ok) {
        setProjects(result.data.projects ?? []);
        setActualsIncluded(result.data.actualsIncluded === true);
      } else setError(result.data.error ?? "خواندن پروژه‌ها ناموفق بود.");
    })();
  }, []);

  return (
    <CompanyWorkspace active="workspace">
      <div className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-bold">پروژه‌های شرکت پلتفرم</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            توسعهٔ پلتفرم، استقرار مشتری، اجرای وب‌سایت، کمپین و عملیات داخلی؛ همه در همان موتور
            پروژهٔ مشترک. بودجه و پیش‌بینی متعلق به پروژه‌اند و از ارقام ثبت‌شدهٔ حسابداری جدا
            نمایش داده می‌شوند.
          </p>
          <Button asChild className="mt-4">
            <a href="/api/platform/company/open?app=workspace">ورود به فضای کاری من</a>
          </Button>
        </section>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <section className="rounded-2xl border border-border bg-card p-5">
          <h3 className="font-bold">فهرست پروژه‌ها</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[54rem] text-sm">
              <thead>
                <tr className="border-b text-right text-muted-foreground">
                  <th className="p-2">پروژه</th>
                  <th className="p-2">وضعیت</th>
                  <th className="p-2">پیش‌بینی / بودجه</th>
                  {actualsIncluded ? <th className="p-2">ثبت‌شدهٔ دفتر</th> : null}
                  <th className="p-2">پیوندها</th>
                </tr>
              </thead>
              <tbody>
                {(projects ?? []).map((project) => (
                  <tr key={project.id} className="border-b align-top last:border-0">
                    <td className="p-2">
                      <strong>{project.name}</strong>
                      <div className="text-xs text-muted-foreground">
                        {project.partyName ? `مشتری: ${project.partyName}` : "بدون مشتری"} ·{" "}
                        {project.doneTaskCount}/{project.taskCount} وظیفه · {project.memberCount} عضو
                      </div>
                      {project.startDate || project.endDate ? (
                        <div className="text-xs text-muted-foreground">
                          {project.startDate ? formatJalali(project.startDate) : "—"}
                          {" تا "}
                          {project.endDate ? formatJalali(project.endDate) : "—"}
                        </div>
                      ) : null}
                    </td>
                    <td className="p-2">{STATUS_LABELS[project.status] ?? project.status}</td>
                    <td className="p-2 whitespace-nowrap">
                      {project.forecastRevenueRial !== null
                        ? `پیش‌بینی ${money.format(project.forecastRevenueRial)}`
                        : "—"}
                      <div className="text-xs text-muted-foreground">
                        {project.budgetRial !== null
                          ? `بودجه ${money.format(project.budgetRial)}`
                          : "بودجه ندارد"}
                      </div>
                    </td>
                    {actualsIncluded ? (
                      <td className="p-2 whitespace-nowrap">
                        {project.postedActuals
                          ? `درآمد ${money.format(project.postedActuals.revenueRial)} · هزینه ${money.format(project.postedActuals.costRial)}`
                          : "ثبت‌نشده"}
                      </td>
                    ) : null}
                    <td className="p-2">
                      {project.links.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {project.links.map((link) => (
                            <li key={`${link.linkKind}:${link.linkedId}`} className="text-xs">
                              <span className="text-muted-foreground">
                                {LINK_LABELS[link.linkKind] ?? link.linkKind}
                              </span>
                              <span className="mx-1 font-mono text-[11px]" dir="ltr">
                                {link.linkedId.slice(0, 8)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {projects !== null && projects.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                هنوز پروژه‌ای ساخته نشده است. از CRM یک معاملهٔ برنده را به پروژه تبدیل کنید.
              </p>
            ) : null}
          </div>
          {!actualsIncluded ? (
            <p className="mt-3 text-xs text-muted-foreground">
              ارقام ثبت‌شدهٔ حسابداری برای نقش شما نمایش داده نمی‌شود؛ بودجه و پیش‌بینی متعلق به
              پروژه هستند و با درآمد دفتری یکی نیستند.
            </p>
          ) : null}
        </section>
      </div>
    </CompanyWorkspace>
  );
}
