"use client";

/**
 * تاریخچه تغییرات — the commercial audit trail: a filtered view over the ONE
 * platform audit log, narrowed to billing actions (plan lifecycle and pricing,
 * subscriptions, overrides, rates, credit packages, gateways, manual payment
 * reviews, wallet adjustments). Every billing write lands here — the console's
 * answer to «who changed the price, when, and from what to what?».
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { api, Card, ErrorBox, inputClass, selectClass, SkeletonRows } from "../../ui";
import { PLATFORM_ROLE_LABELS } from "@/lib/platform-admin";
import { formatJalali } from "@/lib/jalali";
import { summarizePayload } from "./audit-payload-format";

interface AuditEntry {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  businessId: string | null;
  businessName: string | null;
  actorName: string | null;
  actorRole: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  "plan.created": "ایجاد پلن",
  "plan.updated": "ویرایش پلن",
  "plan.activated": "فعال‌سازی پلن",
  "plan.retired": "بازنشستگی پلن",
  "plan.deleted": "حذف پیش‌نویس پلن",
  "plan.price.changed": "تغییر قیمت پلن",
  "plan.limit.changed": "تغییر سقف پلن",
  "plan.capability.changed": "تغییر قابلیت/قیمت پلن",
  "plan.ai_allowance.changed": "تغییر اعتبار هوش مصنوعی پلن",
  "usage_rate.changed": "تغییر تعرفهٔ مصرف",
  "messaging_rate.changed": "تغییر تعرفهٔ پیام‌رسانی",
  "storage_rate.changed": "تغییر تعرفهٔ نگهداری رسانه",
  "credit_package.changed": "تغییر بستهٔ اعتباری",
  "subscription.created": "ایجاد اشتراک",
  "subscription.changed": "تغییر اشتراک",
  "subscription.cancelled": "لغو اشتراک",
  "subscription.renewed": "تمدید اشتراک",
  "business.plan": "انتساب پلن به کسب‌وکار",
  "business.plan.changed": "تغییر پلن کسب‌وکار",
  "business.override.created": "ثبت استثنا (Override)",
  "business.override.removed": "حذف استثنا",
  "gateway.created": "ایجاد درگاه",
  "gateway.updated": "به‌روزرسانی درگاه",
  "gateway.enabled": "فعال‌سازی درگاه",
  "gateway.disabled": "غیرفعال‌سازی درگاه",
  "manual_payment.approved": "تأیید پرداخت دستی",
  "manual_payment.rejected": "رد پرداخت دستی",
  "wallet.adjusted": "تنظیم دستی کیف پول",
  "refund.created": "ثبت بازپرداخت",
  "billing.spend_policy.updated": "تغییر سیاست سقف هزینه",
};

export function BillingAuditTab() {
  const [action, setAction] = useState("");
  const [since, setSince] = useState("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (action) params.set("action", action);
    if (since) params.set("since", since);
    const { ok, data } = await api<{ entries: AuditEntry[]; actions: string[]; error?: string }>(
      `/api/platform/billing/audit?${params.toString()}`,
    );
    if (ok) {
      setEntries(data.entries);
      setActions(data.actions);
    } else {
      setError(data.error ?? "بارگذاری تاریخچه ممکن نشد.");
    }
  }, [action, since]);

  useEffect(() => {
    setEntries(null);
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <Card title="تاریخچه تغییرات تجاری">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            className={selectClass + " h-9 w-56"}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">همهٔ رویدادها</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a] ?? a}
              </option>
            ))}
          </select>
          <input
            type="date"
            className={inputClass + " h-9 w-40"}
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="از تاریخ"
            title="از تاریخ (میلادی)"
          />
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-border p-2 text-foreground hover:bg-muted"
            aria-label="بازخوانی"
          >
            <RefreshCwIcon className="size-4" />
          </button>
        </div>

        {!entries ? (
          <SkeletonRows rows={8} />
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">رویدادی یافت نشد.</p>
        ) : (
          <ol className="space-y-0">
            {entries.map((entry, index) => {
              const summary = summarizePayload(entry.payload);
              return (
                <li
                  key={entry.id}
                  className={`flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4 ${
                    index > 0 ? "border-t border-border" : ""
                  }`}
                >
                  <div className="w-44 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatJalali(entry.createdAt, { withTime: true })}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {ACTION_LABELS[entry.action] ?? entry.action}
                      {entry.entityId && (
                        <span className="mr-2 font-mono text-xs text-muted-foreground" dir="ltr">
                          {entry.entityId}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {entry.actorName ?? "سیستم"}
                      {entry.actorRole ? ` (${PLATFORM_ROLE_LABELS[entry.actorRole as keyof typeof PLATFORM_ROLE_LABELS] ?? entry.actorRole})` : ""}
                      {entry.businessName ? ` • کسب‌وکار: ${entry.businessName}` : ""}
                    </p>
                    {summary && (
                      <p className="mt-1 text-xs text-muted-foreground" dir="auto">
                        {summary}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          هر تغییر تجاری — قیمت، تعرفه، اشتراک، درگاه، پرداخت دستی و تنظیم کیف پول — همزمان با انجام عملیات در این
          تاریخچه ثبت می‌شود و ردیف‌ها قابل ویرایش یا حذف نیستند.
        </p>
      </Card>
    </div>
  );
}
