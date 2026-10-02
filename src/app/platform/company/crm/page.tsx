"use client";

import { useEffect, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, InfoBox } from "../../ui";
import { CompanyWorkspace } from "../_components/company-workspace";
import { formatJalali } from "@/lib/jalali";
import type {
  PlatformCompanyCustomerSummary,
  PlatformCompanyDealSummary,
} from "@/lib/platform-company-types";

const CHURN_LABELS: Record<string, string> = {
  unknown: "نامشخص",
  low: "کم",
  medium: "متوسط",
  high: "بالا",
};

const SUBSCRIPTION_LABELS: Record<string, string> = {
  trialing: "دورهٔ آزمایشی",
  active: "فعال",
  past_due: "عقب‌افتاده",
  cancelled: "لغو شده",
  expired: "منقضی",
};

/**
 * Platform Business CRM landing.
 *
 * It is deliberately a thin adapter: the customer *engine* is the shared CRM
 * this page opens. What it adds is the relationship context the tenant CRM
 * cannot discover on its own — which tenant a billing customer maps to, their
 * subscription state, the posted accounting balance, and the won deals that can
 * be handed to My Workspace.
 *
 * No tenant-private data crosses: no tenant notes, no tenant documents, no
 * tenant ledger, no tenant orders, no tenant staff, and no merging of companies
 * because an email or a phone happens to match.
 */
export default function Page() {
  const money = useMoney();
  const [customers, setCustomers] = useState<PlatformCompanyCustomerSummary[] | null>(null);
  const [deals, setDeals] = useState<PlatformCompanyDealSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = async () => {
    const [customerResult, dealResult] = await Promise.all([
      api<{ customers?: PlatformCompanyCustomerSummary[]; error?: string }>(
        "/api/platform/company/crm/customers",
      ),
      api<{ deals?: PlatformCompanyDealSummary[]; error?: string }>(
        "/api/platform/company/crm/deals",
      ),
    ]);
    if (customerResult.ok) setCustomers(customerResult.data.customers ?? []);
    else setError(customerResult.data.error ?? "خواندن حساب‌های مشتری ناموفق بود.");
    if (dealResult.ok) setDeals(dealResult.data.deals ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  async function createProject(dealId: string) {
    setBusy(dealId);
    setError("");
    setNotice("");
    const result = await api<{ project?: { projectId: string; created: boolean }; error?: string }>(
      "/api/platform/company/workspace/from-deal",
      { method: "POST", body: JSON.stringify({ dealId }) },
    );
    setBusy(null);
    if (!result.ok) {
      setError(result.data.error ?? "ایجاد پروژه ناموفق بود.");
      return;
    }
    setNotice(
      result.data.project?.created
        ? "پروژه ساخته شد. مبلغ معامله فقط پیش‌بینی است و اثر دفتری ندارد."
        : "این معامله پیش‌تر پروژه دارد؛ همان پروژه بازگردانده شد.",
    );
    await load();
  }

  const wonDeals = (deals ?? []).filter((deal) => deal.outcome === "won");

  return (
    <CompanyWorkspace active="crm">
      <div className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-bold">حساب‌های مشتری پلتفرم</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            نگاشت صریح حساب تجاری، صورتحساب و tenantِ مشتری. «ماندهٔ حسابداری» فقط از اسناد ثبت‌شدهٔ
            دفتر محاسبه می‌شود و با «وضعیت اشتراک» یا «ماندهٔ کیف پول» مخلوط نمی‌شود.
          </p>
        </section>

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        <section className="rounded-2xl border border-border bg-card p-5">
          <h3 className="font-bold">مشتریان</h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[54rem] text-sm">
              <thead>
                <tr className="border-b text-right text-muted-foreground">
                  <th className="p-2">مشتری</th>
                  <th className="p-2">tenant‌های متصل</th>
                  <th className="p-2">ماندهٔ حسابداری</th>
                  <th className="p-2">ریزش</th>
                </tr>
              </thead>
              <tbody>
                {(customers ?? []).map((customer) => (
                  <tr key={customer.id} className="border-b align-top last:border-0">
                    <td className="p-2">
                      <strong>{customer.legalName}</strong>
                      <div className="text-xs text-muted-foreground" dir="ltr">
                        {customer.billingCustomerKey}
                      </div>
                      {customer.accountOwner ? (
                        <div className="text-xs text-muted-foreground">
                          مالک حساب: {customer.accountOwner}
                        </div>
                      ) : null}
                    </td>
                    <td className="p-2">
                      {customer.tenants.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <ul className="space-y-1">
                          {customer.tenants.map((tenant) => (
                            <li key={tenant.tenantId} className="text-xs">
                              <span className="font-medium">{tenant.tenantName ?? tenant.tenantId}</span>
                              <span className="mx-1 text-muted-foreground">·</span>
                              <span className="text-muted-foreground">
                                اشتراک:{" "}
                                {tenant.subscriptionStatus
                                  ? (SUBSCRIPTION_LABELS[tenant.subscriptionStatus] ??
                                    tenant.subscriptionStatus)
                                  : "ندارد"}
                              </span>
                              {tenant.walletBalanceRial !== null ? (
                                <>
                                  <span className="mx-1 text-muted-foreground">·</span>
                                  <span className="text-muted-foreground">
                                    کیف پول: {money.format(tenant.walletBalanceRial)}
                                  </span>
                                </>
                              ) : null}
                              {tenant.openInvoiceRial > 0 ? (
                                <>
                                  <span className="mx-1 text-muted-foreground">·</span>
                                  <span className="text-muted-foreground">
                                    صورتحساب باز: {money.format(tenant.openInvoiceRial)}
                                  </span>
                                </>
                              ) : null}
                              {tenant.supportTickets > 0 ? (
                                <>
                                  <span className="mx-1 text-muted-foreground">·</span>
                                  <span className="text-muted-foreground">
                                    {tenant.supportTickets} تیکت پشتیبانی
                                  </span>
                                </>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {money.format(customer.accountingBalanceRial)}
                      <div className="text-xs text-muted-foreground">
                        صادرشده {money.format(customer.invoicedRial)} · وصول{" "}
                        {money.format(customer.settledRial)}
                      </div>
                    </td>
                    <td className="p-2">{CHURN_LABELS[customer.churnRisk] ?? customer.churnRisk}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {customers !== null && customers.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                هنوز نگاشتی از صورتحساب پلتفرم ساخته نشده است؛ با نخستین رویداد معتبر Billing ایجاد
                می‌شود.
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h3 className="font-bold">معاملات برنده و پروژه</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            معاملهٔ برندهٔ واجد شرایط را به «فضای کاری من» بفرستید. مبلغ معامله به‌عنوان پیش‌بینی
            منتقل می‌شود و هرگز درآمد دفتری ثبت نمی‌کند.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b text-right text-muted-foreground">
                  <th className="p-2">معامله</th>
                  <th className="p-2">مبلغ پیش‌بینی</th>
                  <th className="p-2">تاریخ بسته‌شدن</th>
                  <th className="p-2">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {wonDeals.map((deal) => (
                  <tr key={deal.id} className="border-b last:border-0">
                    <td className="p-2">
                      <strong>{deal.title}</strong>
                      {deal.customerName ? (
                        <div className="text-xs text-muted-foreground">{deal.customerName}</div>
                      ) : null}
                    </td>
                    <td className="p-2 whitespace-nowrap">{money.format(deal.valueRial)}</td>
                    <td className="p-2 whitespace-nowrap">
                      {deal.closedAt ? formatJalali(deal.closedAt) : "—"}
                    </td>
                    <td className="p-2">
                      {deal.projectId ? (
                        <span className="text-xs text-muted-foreground">
                          پروژه دارد: {deal.projectName ?? deal.projectId}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy === deal.id}
                          onClick={() => void createProject(deal.id)}
                        >
                          {busy === deal.id ? "در حال ایجاد…" : "ایجاد پروژه"}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {deals !== null && wonDeals.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                معاملهٔ برنده‌ای در CRM شرکت ثبت نشده است.
              </p>
            ) : null}
          </div>
          <Button asChild className="mt-5">
            <a href="/api/platform/company/open?app=crm">ورود به موتور مشترک CRM</a>
          </Button>
        </section>
      </div>
    </CompanyWorkspace>
  );
}
