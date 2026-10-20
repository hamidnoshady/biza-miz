"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import type { OrderControlPolicy } from "@/lib/order-controls";

type Response = {
  policy: OrderControlPolicy;
  businessPolicy: OrderControlPolicy;
  hasBranchOverride: boolean;
  locationName: string;
};

export function OrderControlsSettings() {
  const [data, setData] = useState<Response | null>(null);
  const [discountLimit, setDiscountLimit] = useState("10");
  const [wholeOrderVoidRequiresManager, setWholeOrderVoidRequiresManager] = useState(true);
  const [postKitchenChangeRequiresManager, setPostKitchenChangeRequiresManager] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const requestId = useRef(0);

  const apply = useCallback((response: Response) => {
    setData(response);
    setDiscountLimit(String(response.policy.cashierDiscountLimitPercent));
    setWholeOrderVoidRequiresManager(response.policy.wholeOrderVoidRequiresManager);
    setPostKitchenChangeRequiresManager(response.policy.postKitchenChangeRequiresManager);
  }, []);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    const { ok, data: response } = await api<Response>("/api/settings/order-controls");
    if (id !== requestId.current) return;
    if (ok) apply(response);
    else setError(errorMessage((response as { error?: string }).error));
    setLoading(false);
  }, [apply]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  function updateFromPolicy(policy: OrderControlPolicy, hasBranchOverride: boolean) {
    setData((current) => current
      ? { ...current, policy, hasBranchOverride }
      : current);
    setDiscountLimit(String(policy.cashierDiscountLimitPercent));
    setWholeOrderVoidRequiresManager(policy.wholeOrderVoidRequiresManager);
    setPostKitchenChangeRequiresManager(policy.postKitchenChangeRequiresManager);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const amount = Number(discountLimit);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100) {
      setError("سقف تخفیف باید عددی بین صفر تا صد باشد.");
      return;
    }
    const policy: OrderControlPolicy = {
      cashierDiscountLimitPercent: amount,
      wholeOrderVoidRequiresManager,
      postKitchenChangeRequiresManager,
    };
    const id = ++requestId.current;
    setSaving(true);
    setSaved(false);
    setError("");
    const { ok, data: response } = await api<{ ok?: boolean; error?: string; policy?: OrderControlPolicy; hasBranchOverride?: boolean }>(
      "/api/settings/order-controls",
      { method: "PUT", body: JSON.stringify(policy) },
    );
    if (id !== requestId.current) return;
    setSaving(false);
    if (!ok || !response.policy) {
      setError(errorMessage(response.error));
      return;
    }
    updateFromPolicy(response.policy, response.hasBranchOverride ?? true);
    setSaved(true);
  }

  async function inheritBusinessDefault() {
    if (saving || !data?.hasBranchOverride) return;
    const id = ++requestId.current;
    setSaving(true);
    setSaved(false);
    setError("");
    const { ok, data: response } = await api<{ ok?: boolean; error?: string; policy?: OrderControlPolicy; hasBranchOverride?: boolean }>(
      "/api/settings/order-controls",
      { method: "PUT", body: JSON.stringify({ inheritBusinessDefault: true }) },
    );
    if (id !== requestId.current) return;
    setSaving(false);
    if (!ok || !response.policy) {
      setError(errorMessage(response.error));
      return;
    }
    updateFromPolicy(response.policy, response.hasBranchOverride ?? false);
    setSaved(true);
  }

  if (loading) {
    return <SectionCard title="کنترل‌های سفارش"><div role="status" className="ops-skeleton h-40 rounded-xl" /></SectionCard>;
  }

  if (!data) {
    return (
      <SectionCard title="کنترل‌های سفارش">
        <div className="space-y-3">
          <ErrorBox>{error}</ErrorBox>
          <Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button>
        </div>
      </SectionCard>
    );
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <SectionCard
        title="کنترل‌های سفارش"
        description={`سیاست تأیید سفارش برای شعبهٔ ${data.locationName}. تغییرات این بخش ثبت حسابرسی می‌شود.`}
        actions={data.hasBranchOverride ? (
          <Button type="button" variant="outline" disabled={saving} onClick={() => void inheritBusinessDefault()}>
            بازگشت به تنظیم سراسری
          </Button>
        ) : null}
      >
        <div className="space-y-4">
          <ErrorBox>{error}</ErrorBox>
          {saved ? <InfoBox>کنترل‌های سفارش ذخیره شد و رویداد آن در گزارش حسابرسی ثبت شد.</InfoBox> : null}
          {!data.hasBranchOverride ? (
            <InfoBox>این شعبه از تنظیم سراسری کسب‌وکار پیروی می‌کند. ذخیرهٔ تغییرات، یک تنظیم اختصاصی برای همین شعبه می‌سازد.</InfoBox>
          ) : null}

          <Field label="حداکثر تخفیف صندوق‌دار (درصد)" hint="صندوق‌دار می‌تواند تا این درصد تخفیف ثبت کند؛ تخفیف بیشتر به دسترسی مدیر نیاز دارد.">
            <PersianNumberInput
              className={inputClass}
              min={0}
              max={100}
              step="0.1"
              inputMode="decimal"
              value={discountLimit}
              onChange={(event) => { setSaved(false); setDiscountLimit(event.target.value); }}
              required
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-3 rounded-xl border border-border p-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={wholeOrderVoidRequiresManager}
                onChange={(event) => { setSaved(false); setWholeOrderVoidRequiresManager(event.target.checked); }}
              />
              <span>
                <span className="block text-sm font-medium text-foreground">ابطال کل سفارش نیازمند تأیید مدیر باشد</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">ابطال همراه با دلیل اجباری و ثبت در گزارش حسابرسی انجام می‌شود.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-border p-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={postKitchenChangeRequiresManager}
                onChange={(event) => { setSaved(false); setPostKitchenChangeRequiresManager(event.target.checked); }}
              />
              <span>
                <span className="block text-sm font-medium text-foreground">تغییر سفارش پس از ارسال به آشپزخانه نیازمند تأیید مدیر باشد</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">ابطال یا تغییر اقلام پس از شروع آماده‌سازی، بدون دسترسی مدیر پذیرفته نمی‌شود.</span>
              </span>
            </label>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            تنظیم سراسری کسب‌وکار: سقف تخفیف {data.businessPolicy.cashierDiscountLimitPercent}٪، ابطال سفارش {data.businessPolicy.wholeOrderVoidRequiresManager ? "با تأیید مدیر" : "بدون تأیید مدیر"}، تغییر پس از آشپزخانه {data.businessPolicy.postKitchenChangeRequiresManager ? "با تأیید مدیر" : "بدون تأیید مدیر"}.
          </p>
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیرهٔ کنترل‌ها"}
            </Button>
          </div>
        </div>
      </SectionCard>
    </form>
  );
}
