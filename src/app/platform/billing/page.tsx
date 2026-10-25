"use client";

/**
 * The Billing Control Center — the ONE Superadmin commercial management area
 * (migration 0176). Everything customer-facing about money is configured
 * here: plans and packaging, metered rates and credit products,
 * subscriptions, invoices, payments and the manual review queue, the payment
 * gateway, billing rules, and the commercial audit history.
 *
 * One canonical route, tabbed (no second Plan Builder elsewhere): the tab
 * rides the `?tab=` query param so every section is linkable —
 * `/platform/billing?tab=plans`, `?tab=usage`, … — and the retired routes
 * (`/platform/plans`, business `/plan`) redirect into these tabs.
 */
import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { WalletIcon } from "lucide-react";
import { useCan } from "../ui";
import { BillingTabBar, BILLING_TABS, type BillingTab } from "../_components/billing/tab-bar";
import { BillingOverviewTab } from "../_components/billing/overview-tab";
import { BillingPlansTab } from "../_components/billing/plans-tab";
import { BillingUsageTab } from "../_components/billing/usage-tab";
import { BillingSubscriptionsTab } from "../_components/billing/subscriptions-tab";
import { BillingInvoicesTab } from "../_components/billing/invoices-tab";
import { BillingPaymentsTab } from "../_components/billing/payments-tab";
import { BillingGatewaysTab } from "../_components/billing/gateways-tab";
import { BillingAuditTab } from "../_components/billing/audit-tab";
import { BillingMetersTab, BillingRulesTab, BillingSpendTab } from "../_components/billing/commercial-tabs";
import { BillingRetentionTab, BillingServicesTab } from "../_components/billing/services-tab";

export default function PlatformBillingPage() {
  const can = useCan();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab") ?? "overview";
  const tab: BillingTab = BILLING_TABS.some((t) => t.key === rawTab)
    ? (rawTab as BillingTab)
    : "overview";

  const setTab = useCallback(
    (next: BillingTab) => {
      router.replace(`/platform/billing?tab=${next}`, { scroll: false });
    },
    [router],
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
      <header className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700 dark:text-sky-300">
          <WalletIcon className="size-5" />
        </span>
        <div>
          <h1 className="text-lg font-bold text-foreground">صورت‌حساب و درآمد</h1>
          <p className="text-sm text-muted-foreground">
            مرکز مدیریت تجاری پلتفرم: پلن‌ها، تعرفه‌ها، اشتراک‌ها، فاکتورها، پرداخت‌ها و درگاه
          </p>
        </div>
      </header>

      <BillingTabBar active={tab} onChange={setTab} can={can} />

      {tab === "overview" && <BillingOverviewTab />}
      {tab === "plans" && <BillingPlansTab />}
      {tab === "usage" && <BillingUsageTab />}
      {tab === "meters" && <BillingMetersTab />}
      {tab === "subscriptions" && <BillingSubscriptionsTab />}
      {tab === "invoices" && <BillingInvoicesTab />}
      {tab === "payments" && <BillingPaymentsTab />}
      {tab === "spend" && <BillingSpendTab />}
      {tab === "services" && <BillingServicesTab />}
      {tab === "retention" && <BillingRetentionTab />}
      {tab === "gateways" && <BillingGatewaysTab />}
      {tab === "rules" && <BillingRulesTab />}
      {tab === "audit" && <BillingAuditTab />}
    </div>
  );
}
