"use client";

/**
 * Issue #902 — the Superadmin control plane for managed SMS accounts.
 *
 * Shown inside `/platform/messaging` as its own card because the account fleet
 * is operational, not part of the provider connection: the connection is one
 * master credential, while this screen is one row per business, with the
 * provider's own state, tariff, balance and key hint.
 *
 * Everything here is provider-facing. That is allowed on this surface and
 * nowhere else — tenant screens receive `getTenantMessagingConfig()` instead.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2Icon, RefreshCwIcon, SaveIcon, ShieldCheckIcon, WalletCardsIcon } from "lucide-react";
import { formatPersianNumber } from "@/lib/digits";
import { tomanLabel } from "@/lib/platform-money";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass } from "../ui";

interface ManagedPolicy {
  enabled: boolean;
  planId: number | null;
  minAllowedCreditRial: number;
  senderLines: string[];
  note: string | null;
  fundingBufferMessages: number;
  fundingChildCapRial: number | null;
  fundingDailyCapRial: number | null;
  fundingMasterFloorRial: number;
  updatedAt: string | null;
}

interface ManagedAccount {
  id: string;
  businessId: string;
  businessName: string | null;
  localId: string;
  username: string;
  state:
    | "not_provisioned"
    | "pending"
    | "provisioning"
    | "active"
    | "retry_pending"
    | "attention_required"
    | "suspended";
  attentionReason: string | null;
  providerStatus: string | null;
  keyHint: string | null;
  planId: number | null;
  pricingName: string | null;
  smsFarsiCostRial: number | null;
  smsEnglishCostRial: number | null;
  providerBalanceRial: number | null;
  providerBalanceAt: string | null;
  senderLines: string[];
  adopted: boolean;
  provisionedAt: string | null;
  suspendedAt: string | null;
}

interface ManagedJob {
  id: string;
  businessId: string;
  kind: string;
  state: string;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
}

interface UnresolvedTransfer {
  id: string;
  businessId: string;
  amountRial: number;
  state: string;
  createdAt: string;
}

interface MarginRow {
  businessId: string;
  businessName: string | null;
  retailChargedRial: number;
  providerCostRial: number;
  marginRial: number;
  unreportedCostSends: number;
  sends: number;
}

interface ReconciliationRow {
  id: string;
  business_id: string;
  state: "ok" | "drift" | "incomplete";
  delta_rial: string | number | null;
  provider_balance_rial: string | number | null;
  provider_cost_rial: string | number;
  retail_charged_rial: string | number;
  created_at: string;
}

interface Snapshot {
  error?: string;
  policy: ManagedPolicy;
  accounts: ManagedAccount[];
  recentJobs: ManagedJob[];
  unresolvedTransfers: UnresolvedTransfer[];
  margin: MarginRow[];
  reconciliation: ReconciliationRow[];
}

const STATE_LABELS: Record<ManagedAccount["state"], string> = {
  not_provisioned: "در انتظار",
  pending: "در صف",
  provisioning: "در حال ساخت",
  active: "فعال",
  retry_pending: "تلاش دوباره",
  attention_required: "نیازمند اقدام",
  suspended: "معلق",
};

const JOB_LABELS: Record<string, string> = {
  provision: "ساخت",
  sync: "همگام‌سازی",
  suspend: "تعلیق",
  reactivate: "فعال‌سازی",
  rotate_key: "چرخش کلید",
  adopt: "پذیرش",
};

const dateTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))
    : "—";

export function ManagedSmsAccountsCard({ canManage }: { canManage: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [policy, setPolicy] = useState<ManagedPolicy | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transfer, setTransfer] = useState({ businessId: "", amountRial: "", reason: "" });
  const [probe, setProbe] = useState<{ eligible: boolean; code: string | null } | null>(null);

  const load = useCallback(async () => {
    const result = await api<Snapshot>("/api/platform/sms/accounts");
    if (!result.ok) {
      setError(result.data.error ?? "دریافت حساب‌های مدیریت‌شده ممکن نشد.");
      return;
    }
    setSnapshot(result.data);
    setPolicy(result.data.policy);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const accounts = snapshot?.accounts ?? [];
    return {
      active: accounts.filter((account) => account.state === "active").length,
      attention: accounts.filter((account) => account.state === "attention_required").length,
      suspended: accounts.filter((account) => account.state === "suspended").length,
    };
  }, [snapshot]);

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await api<{ error?: string; [key: string]: unknown }>(
      "/api/platform/sms/accounts",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "عملیات انجام نشد.");
      return null;
    }
    await load();
    return result.data;
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!policy) return;
    const done = await post(
      {
        action: "policy",
        enabled: policy.enabled,
        planId: policy.planId,
        minAllowedCreditRial: policy.minAllowedCreditRial,
        senderLines: policy.senderLines.join(","),
        note: policy.note,
        fundingBufferMessages: policy.fundingBufferMessages,
        fundingChildCapRial: policy.fundingChildCapRial,
        fundingDailyCapRial: policy.fundingDailyCapRial,
        fundingMasterFloorRial: policy.fundingMasterFloorRial,
      },
      "policy",
    );
    if (done) setNotice("سیاست حساب‌های مدیریت‌شده ذخیره شد.");
  }

  async function runProbe() {
    const result = await post({ action: "probe" }, "probe");
    if (!result) return;
    const value = result as { eligible?: boolean; code?: string | null };
    setProbe({ eligible: value.eligible === true, code: value.code ?? null });
  }

  async function runAction(businessId: string, action: string) {
    const done = await post({ action, businessId }, action + businessId);
    if (done) setNotice(`درخواست «${JOB_LABELS[action] ?? action}» ثبت شد.`);
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    if (!transfer.businessId || !transfer.amountRial) return;
    const result = await post(
      {
        action: "transfer",
        businessId: transfer.businessId.trim(),
        amountRial: Number(transfer.amountRial),
        reason: transfer.reason || undefined,
        // A per-click key: a double click is answered from the committed row,
        // never by moving money twice.
        idempotencyKey: `console:${crypto.randomUUID()}`,
      },
      "transfer",
    );
    if (result) {
      setTransfer({ businessId: "", amountRial: "", reason: "" });
      setNotice("انتقال اعتبار ثبت شد؛ نتیجهٔ نهایی در فهرست انتقال‌های بازنشده دیده می‌شود.");
    }
  }

  if (!snapshot || !policy) return <Card title="حساب‌های مدیریت‌شده">{error ? <ErrorBox>{error}</ErrorBox> : null}در حال خواندن…</Card>;

  return (
    <div className="space-y-4">
      <Card title="حساب‌های مدیریت‌شدهٔ پیامک">
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        <div className="grid gap-3 text-sm sm:grid-cols-4">
          <p>فعال: <b>{formatPersianNumber(counts.active)}</b></p>
          <p>نیازمند اقدام: <b>{formatPersianNumber(counts.attention)}</b></p>
          <p>معلق: <b>{formatPersianNumber(counts.suspended)}</b></p>
          <p>کل: <b>{formatPersianNumber(snapshot.accounts.length)}</b></p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={() => void runProbe()} disabled={!canManage || busy === "probe"}>
            {busy === "probe" ? <Loader2Icon className="size-4 animate-spin" /> : <ShieldCheckIcon className="size-4" />}
            بررسی دسترسی حساب مادر
          </Button>
          <Button variant="ghost" onClick={() => void load()} disabled={busy !== ""}>
            <RefreshCwIcon className="size-4" /> تازه‌سازی
          </Button>
          {probe ? (
            <span className="text-sm">
              نتیجهٔ بررسی:{" "}
              <b>{probe.eligible ? "حساب مادر مجاز است" : `غیرمجاز (${probe.code ?? "نامشخص"})`}</b>
            </span>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          حساب فرزند تنها پس از تأیید دسترسی حساب مادر و با روشن‌کردن سیاست زیر ساخته می‌شود.
          کلید فرزند هرگز نمایش داده نمی‌شود؛ فقط چهار رقم آخر آن برای تطبیق.
        </p>
      </Card>

      <Card title="سیاست ساخت و تأمین اعتبار">
        <form onSubmit={savePolicy} className="grid gap-3 sm:grid-cols-2">
          <Field label="ساخت خودکار حساب فرزند" hint="تا روشن نشدن این گزینه هیچ حسابی ساخته نمی‌شود.">
            <select
              className={inputClass}
              value={policy.enabled ? "yes" : "no"}
              disabled={!canManage}
              onChange={(event) => setPolicy({ ...policy, enabled: event.target.value === "yes" })}
            >
              <option value="no">خاموش</option>
              <option value="yes">روشن</option>
            </select>
          </Field>
          <Field label="شناسهٔ تعرفهٔ ارائه‌دهنده" hint="خالی = تعرفهٔ پیش‌فرض حساب مادر.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.planId ?? ""}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({ ...policy, planId: event.target.value ? Number(event.target.value) : null })
              }
            />
          </Field>
          <Field label="حداقل اعتبار مجاز فرزند (ریال)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.minAllowedCreditRial}
              disabled={!canManage}
              onChange={(event) => setPolicy({ ...policy, minAllowedCreditRial: Number(event.target.value) || 0 })}
            />
          </Field>
          <Field label="خطوط ارسال" hint="با کاما جدا کنید.">
            <input
              className={inputClass}
              dir="ltr"
              value={policy.senderLines.join(",")}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  senderLines: event.target.value.split(",").map((line) => line.trim()).filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="بافر پیام برای تأمین خودکار" hint="۰ = تأمین خودکار خاموش؛ عدد = تعداد پیام قابل ارسال که حساب فرزند باید داشته باشد.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingBufferMessages}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({ ...policy, fundingBufferMessages: Number(event.target.value) || 0 })
              }
            />
          </Field>
          <Field label="سقف اعتبار هر فرزند (ریال)" hint="خالی = بدون سقف.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingChildCapRial ?? ""}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingChildCapRial: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
          </Field>
          <Field label="سقف تأمین روزانه (ریال)" hint="خالی = بدون سقف.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingDailyCapRial ?? ""}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  fundingDailyCapRial: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
          </Field>
          <Field label="کف اعتبار حساب مادر (ریال)" hint="با مقدار مثبت، تأمین خودکار بدون موجودی مشخص انجام نمی‌شود.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={policy.fundingMasterFloorRial}
              disabled={!canManage}
              onChange={(event) =>
                setPolicy({ ...policy, fundingMasterFloorRial: Number(event.target.value) || 0 })
              }
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="یادداشت سیاست">
              <textarea
                className={`${inputClass} h-20`}
                value={policy.note ?? ""}
                disabled={!canManage}
                onChange={(event) => setPolicy({ ...policy, note: event.target.value || null })}
              />
            </Field>
          </div>
          {canManage ? (
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy === "policy"}>
                {busy === "policy" ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
                ذخیرهٔ سیاست
              </Button>
            </div>
          ) : null}
        </form>
      </Card>

      <Card title="انتقال اعتبار به حساب فرزند">
        <form onSubmit={submitTransfer} className="grid gap-3 sm:grid-cols-3">
          <Field label="شناسهٔ کسب‌وکار">
            <input
              className={inputClass}
              dir="ltr"
              value={transfer.businessId}
              disabled={!canManage}
              onChange={(event) => setTransfer({ ...transfer, businessId: event.target.value })}
            />
          </Field>
          <Field label="مبلغ (ریال)" hint="حداقل ۱۰۰۰ ریال.">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={transfer.amountRial}
              disabled={!canManage}
              onChange={(event) => setTransfer({ ...transfer, amountRial: event.target.value })}
            />
          </Field>
          <Field label="دلیل">
            <input
              className={inputClass}
              value={transfer.reason}
              disabled={!canManage}
              onChange={(event) => setTransfer({ ...transfer, reason: event.target.value })}
            />
          </Field>
          {canManage ? (
            <div className="sm:col-span-3">
              <Button type="submit" disabled={busy === "transfer" || !transfer.businessId || !transfer.amountRial}>
                {busy === "transfer" ? <Loader2Icon className="size-4 animate-spin" /> : <WalletCardsIcon className="size-4" />}
                انتقال اعتبار
              </Button>
            </div>
          ) : null}
        </form>
        <p className="mt-3 text-xs text-muted-foreground">
          اعتبار ارائه‌دهنده پیش‌تأمین داخلی است و هرگز به‌عنوان اعتبار کسب‌وکار نمایش داده نمی‌شود؛
          موجودی قابل خرج کسب‌وکار همان کیف پول مرکزی است. هر انتقال یک ردیف دفتر با کلید یکتا دارد.
        </p>
      </Card>

      <Card title={`حساب‌ها (${formatPersianNumber(snapshot.accounts.length)})`}>
        <div className="space-y-2">
          {snapshot.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">هنوز حسابی ساخته نشده است.</p>
          ) : (
            snapshot.accounts.map((account) => (
              <div key={account.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {account.businessName ?? account.businessId} • {STATE_LABELS[account.state]}
                    {account.attentionReason ? ` • ${account.attentionReason}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {account.username} • {account.keyHint ? `••••${account.keyHint.replace(/^•+/, "")}` : "بدون کلید"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  تعرفه: {account.pricingName ?? "—"} • فارسی {tomanLabel(account.smsFarsiCostRial ?? 0)} • انگلیسی{" "}
                  {tomanLabel(account.smsEnglishCostRial ?? 0)} • موجودی داخلی{" "}
                  {account.providerBalanceRial === null ? "نامشخص" : tomanLabel(account.providerBalanceRial)} •{" "}
                  {dateTime(account.providerBalanceAt)}
                </p>
                {canManage ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "sync")}>
                      همگام‌سازی
                    </Button>
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "fund")}>
                      تأمین اعتبار
                    </Button>
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "reconcile")}>
                      تطبیق
                    </Button>
                    <Button variant="ghost" onClick={() => void runAction(account.businessId, "rotate_key")}>
                      چرخش کلید
                    </Button>
                    {account.state === "suspended" ? (
                      <Button variant="ghost" onClick={() => void runAction(account.businessId, "reactivate")}>
                        فعال‌سازی
                      </Button>
                    ) : (
                      <Button variant="danger" onClick={() => void runAction(account.businessId, "suspend")}>
                        تعلیق
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="کارهای اخیر">
          <div className="space-y-2 text-sm">
            {snapshot.recentJobs.length === 0 ? (
              <p className="text-muted-foreground">کاری ثبت نشده است.</p>
            ) : (
              snapshot.recentJobs.slice(0, 10).map((job) => (
                <div key={job.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {JOB_LABELS[job.kind] ?? job.kind} • {job.state} • تلاش {formatPersianNumber(job.attempts)}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {job.lastErrorCode ?? "—"} • {dateTime(job.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
        <Card title="انتقال‌های بازنشده">
          <div className="space-y-2 text-sm">
            {snapshot.unresolvedTransfers.length === 0 ? (
              <p className="text-muted-foreground">موردی نیست.</p>
            ) : (
              snapshot.unresolvedTransfers.map((row) => (
                <div key={row.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {tomanLabel(row.amountRial)} • {row.state}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {dateTime(row.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card title="حاشیهٔ سود ۳۰ روز اخیر (فروش منهای هزینهٔ ارائه‌دهنده)">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="p-2 text-right">کسب‌وکار</th>
                <th className="p-2 text-right">فروش</th>
                <th className="p-2 text-right">هزینهٔ ارائه‌دهنده</th>
                <th className="p-2 text-right">حاشیه</th>
                <th className="p-2 text-right">ارسال</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.margin.length === 0 ? (
                <tr>
                  <td className="p-2 text-muted-foreground" colSpan={5}>
                    داده‌ای برای این بازه نیست.
                  </td>
                </tr>
              ) : (
                snapshot.margin.slice(0, 8).map((row) => (
                  <tr key={row.businessId} className="border-t border-border">
                    <td className="p-2">{row.businessName ?? row.businessId}</td>
                    <td className="p-2 tabular-nums">{tomanLabel(row.retailChargedRial)}</td>
                    <td className="p-2 tabular-nums">{tomanLabel(row.providerCostRial)}</td>
                    <td className={`p-2 tabular-nums ${row.marginRial < 0 ? "text-destructive" : ""}`}>
                      {tomanLabel(row.marginRial)}
                    </td>
                    <td className="p-2 tabular-nums">{formatPersianNumber(row.sends)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="تطبیق‌های اخیر">
        <div className="space-y-2 text-sm">
          {snapshot.reconciliation.length === 0 ? (
            <p className="text-muted-foreground">تطبیقی اجرا نشده است.</p>
          ) : (
            snapshot.reconciliation.slice(0, 8).map((row) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {row.business_id} • {row.state === "ok" ? "مطابق" : row.state === "drift" ? "اختلاف" : "ناقص"}
                </span>
                <span className="text-xs text-muted-foreground" dir="ltr">
                  Δ {row.delta_rial === null ? "—" : tomanLabel(Number(row.delta_rial))} •{" "}
                  {dateTime(row.created_at)}
                </span>
              </div>
            ))
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          موجودی داخلی در برابر دفتر ما: انتقال‌های تأییدشده منهای هزینهٔ ثبت‌شدهٔ ارسال‌ها. اختلاف با
          تلورانس مشخص گزارش می‌شود، نه با گرد کردن.
        </p>
      </Card>
    </div>
  );
}
