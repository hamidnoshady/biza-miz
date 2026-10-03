"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox, InfoBox } from "../../ui";
import { CompanyWorkspace } from "../_components/company-workspace";

interface Audience {
  leads: { total: number; byStatus: Record<string, number>; websiteLeads: number; unconverted: number };
  consent: { sms: number; email: number; partiesWithConsent: number };
  customers: { total: number; byChurnRisk: Record<string, number> };
  campaigns: { total: number; draft: number; sending: number; completed: number };
  renewalCandidates: {
    tenantId: string;
    tenantName: string | null;
    periodEnd: string | null;
    daysLeft: number | null;
  }[];
}

const LEAD_STATUS_LABELS: Record<string, string> = {
  new: "جدید",
  contacted: "تماس گرفته‌شده",
  qualified: "واجد شرایط",
  converted: "تبدیل‌شده",
  disqualified: "ردشده",
};

const CHURN_LABELS: Record<string, string> = { unknown: "نامشخص", low: "کم", medium: "متوسط", high: "بالا" };

/**
 * Platform Business Growth landing.
 *
 * The campaign engine is the shared Growth app this page opens — nothing here
 * sends, schedules or activates anything. What it adds is the platform-side
 * audience picture the tenant engine cannot see: CRM-owned leads by source and
 * status, who has actually consented, which mapped customers are at churn risk,
 * and which customer tenants come up for renewal in the next two weeks.
 *
 * Two rules the page states rather than assumes: activation is always an
 * explicit act inside the shared engine, and marketing attribution is never
 * presented as posted revenue — only Accounting confirms revenue.
 */
export default function Page() {
  const [audience, setAudience] = useState<Audience | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const result = await api<{ audience?: Audience; error?: string }>(
        "/api/platform/company/growth/audience",
      );
      if (result.ok) setAudience(result.data.audience ?? null);
      else setError(result.data.error ?? "خواندن خلاصهٔ مخاطبان ناموفق بود.");
    })();
  }, []);

  return (
    <CompanyWorkspace active="growth">
      <div className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-bold">رشد و بازاریابی شرکت پلتفرم</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            جذب لید، همراهی دورهٔ آزمایشی، تبدیل، تمدید، بازفعال‌سازی، ارجاع و پورسانت شریک؛ همگی
            روی مخاطب و رضایت CRM. هیچ ارسالی در مهاجرت، راه‌اندازی، پرکردن تاریخچه یا استقرار
            انجام نمی‌شود و فعال‌سازی کمپین فقط در موتور رشد و به‌صورت صریح است.
          </p>
          <Button asChild className="mt-4">
            <a href="/api/platform/company/open?app=growth">ورود به موتور رشد</a>
          </Button>
        </section>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <InfoBox>
          درآمد منتسب به بازاریابی، درآمد ثبت‌شده نیست. تنها اسناد ثبت‌شدهٔ حسابداری درآمد دفتری
          محسوب می‌شوند.
        </InfoBox>

        {audience ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="لیدهای CRM" value={audience.leads.total} hint={`${audience.leads.websiteLeads} از فرم سایت`} />
              <Stat
                label="رضایت ثبت‌شده"
                value={audience.consent.partiesWithConsent}
                hint={`پیامک ${audience.consent.sms} · ایمیل ${audience.consent.email}`}
              />
              <Stat label="حساب‌های مشتری" value={audience.customers.total} hint="نگاشت‌شده در CRM پلتفرم" />
              <Stat
                label="کمپین‌ها"
                value={audience.campaigns.total}
                hint={`پیش‌نویس ${audience.campaigns.draft} · در حال ارسال ${audience.campaigns.sending}`}
              />
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-bold">ریسک ریزش حساب‌ها</h3>
              <ul className="mt-3 flex flex-wrap gap-2 text-sm">
                {Object.entries(audience.customers.byChurnRisk).length === 0 ? (
                  <li className="text-muted-foreground">حسابی ثبت نشده است.</li>
                ) : (
                  Object.entries(audience.customers.byChurnRisk).map(([risk, count]) => (
                    <li key={risk} className="rounded-xl bg-muted/60 px-3 py-2">
                      {CHURN_LABELS[risk] ?? risk}: <strong>{count}</strong>
                    </li>
                  ))
                )}
              </ul>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-bold">تمدیدهای پیش‌رو (۱۴ روز)</h3>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="border-b text-right text-muted-foreground">
                      <th className="p-2">tenant مشتری</th>
                      <th className="p-2">پایان دوره</th>
                      <th className="p-2">مانده</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audience.renewalCandidates.map((candidate) => (
                      <tr key={candidate.tenantId} className="border-b last:border-0">
                        <td className="p-2">{candidate.tenantName ?? candidate.tenantId}</td>
                        <td className="p-2 whitespace-nowrap">
                          {candidate.periodEnd ? formatJalali(candidate.periodEnd) : "—"}
                        </td>
                        <td className="p-2">
                          {candidate.daysLeft === null
                            ? "—"
                            : candidate.daysLeft <= 0
                              ? "اکنون"
                              : `${candidate.daysLeft} روز`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {audience.renewalCandidates.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    تمدیدی در ۱۴ روز پیش‌رو نیست.
                  </p>
                ) : null}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                این فهرست فقط نام کسب‌وکار و تاریخ پایان دوره را می‌خواند؛ ارسال یادآوری تمدید باید
                در موتور رشد و با رعایت رضایت و فهرست سرکوب فعال شود.
              </p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-bold">لیدها بر پایهٔ وضعیت</h3>
              <ul className="mt-3 flex flex-wrap gap-2 text-sm">
                {Object.entries(audience.leads.byStatus).length === 0 ? (
                  <li className="text-muted-foreground">لیدی ثبت نشده است.</li>
                ) : (
                  Object.entries(audience.leads.byStatus).map(([status, count]) => (
                    <li key={status} className="rounded-xl bg-muted/60 px-3 py-2">
                      {LEAD_STATUS_LABELS[status] ?? status}: <strong>{count}</strong>
                    </li>
                  ))
                )}
              </ul>
            </section>
          </>
        ) : null}
      </div>
    </CompanyWorkspace>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <article className="rounded-2xl border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </article>
  );
}
