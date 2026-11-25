"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import type { KitchenWorkflow } from "@/lib/kitchen-workflow";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { api, errorMessage, inputClass } from "@/app/dashboard/ui";

type Response = {
  workflow?: KitchenWorkflow;
  clearAfterPayment?: boolean;
  clearAfterMinutes?: number | null;
  clearAfterShift?: boolean;
  error?: string;
};

/**
 * «آماده‌سازی و بایگانی سفارش‌های آشپزخانه» — the kitchen half of the
 * /settings/orders tab.
 *
 * The pass's workflow used to live behind a button on the kitchen board; it
 * is business configuration (how this branch's tickets leave the board), so
 * it sits beside the other order policy here. One exit is not a setting at
 * all and is deliberately absent from the form: a ticket whose business day
 * has passed leaves the board on its own, so there is no manual
 * «بررسی سفارش‌های قدیمی» pass left to configure.
 */
export function KitchenWorkflowSettings() {
  const [workflow, setWorkflow] = useState<KitchenWorkflow>("kitchen_team");
  const [saved, setSaved] = useState<KitchenWorkflow | null>(null);
  const [clearAfterPayment, setClearAfterPayment] = useState(false);
  const [savedClearAfterPayment, setSavedClearAfterPayment] = useState(false);
  const [clearAfterMinutes, setClearAfterMinutes] = useState("");
  const [savedClearAfterMinutes, setSavedClearAfterMinutes] = useState("");
  const [clearAfterShift, setClearAfterShift] = useState(false);
  const [savedClearAfterShift, setSavedClearAfterShift] = useState(false);
  const minutes = clearAfterMinutes === "" ? null : Number(clearAfterMinutes);
  const validMinutes = minutes === null || (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api<Response>("/api/kitchen/workflow", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok && result.data.workflow) {
        setWorkflow(result.data.workflow);
        setSaved(result.data.workflow);
        setClearAfterPayment(result.data.clearAfterPayment === true);
        setSavedClearAfterPayment(result.data.clearAfterPayment === true);
        const savedMinutes = result.data.clearAfterMinutes == null ? "" : String(result.data.clearAfterMinutes);
        setClearAfterMinutes(savedMinutes);
        setSavedClearAfterMinutes(savedMinutes);
        setClearAfterShift(result.data.clearAfterShift === true);
        setSavedClearAfterShift(result.data.clearAfterShift === true);
      } else {
        setError(errorMessage(result.data.error));
      }
    });
    return () => controller.abort();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<Response>("/api/kitchen/workflow", {
        method: "PUT",
        body: JSON.stringify({ workflow, clearAfterPayment, clearAfterMinutes: minutes, clearAfterShift }),
      });
      if (!result.ok || !result.data.workflow) {
        setError(errorMessage(result.data.error));
        return;
      }
      setSaved(result.data.workflow);
      setSavedClearAfterPayment(result.data.clearAfterPayment === true);
      setSavedClearAfterMinutes(result.data.clearAfterMinutes == null ? "" : String(result.data.clearAfterMinutes));
      setSavedClearAfterShift(result.data.clearAfterShift === true);
      toast.success("روش آماده‌سازی سفارش‌های این شعبه ذخیره شد.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="آماده‌سازی و بایگانی سفارش‌های آشپزخانه"
      description="این شعبه سفارش‌هایش را چگونه آماده می‌کند و صف آشپزخانه چگونه خالی می‌شود. سفارش‌هایی که از روز کاری خود عبور کنند، بدون تنظیم و به‌طور خودکار از صف بایگانی می‌شوند."
    >
      <h2 className="font-semibold">آماده‌سازی سفارش‌های این شعبه</h2>
      {!error && saved === null ? <LoadingSkeleton rows={3} /> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="block text-sm">روش آماده‌سازی سفارش</span>
          <select className={inputClass} value={workflow} disabled={busy || saved === null}
            onChange={(event) => {
              setWorkflow(event.currentTarget.value as KitchenWorkflow);
            }}>
            <option value="kitchen_team">تغییر وضعیت توسط تیم آشپزخانه</option>
            <option value="manage_from_orders">آماده‌سازی از بخش سفارش‌ها</option>
            <option value="ready_on_send">آماده هنگام ثبت سفارش</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clearAfterPayment} disabled={busy || saved === null}
            onChange={(event) => setClearAfterPayment(event.currentTarget.checked)} />
          خروج سفارش آماده از صف پس از پرداخت کامل
        </label>
        <label className="space-y-1">
          <span className="block text-sm">خروج خودکار پس از آماده‌شدن (دقیقه)</span>
          <PersianNumberInput min={1} max={1440} step={1} inputMode="numeric" placeholder="خاموش"
            className={inputClass} value={clearAfterMinutes} disabled={busy || saved === null}
            onChange={(event) => setClearAfterMinutes(event.currentTarget.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clearAfterShift} disabled={busy || saved === null}
            onChange={(event) => setClearAfterShift(event.currentTarget.checked)} />
          خروج سفارش آماده هنگام بستن شیفت مربوط
        </label>
        <Button type="button" disabled={busy || saved === null || !validMinutes ||
          (saved === workflow && savedClearAfterPayment === clearAfterPayment &&
            savedClearAfterMinutes === clearAfterMinutes && savedClearAfterShift === clearAfterShift)}
          onClick={() => void save()}>
          ذخیره
        </Button>
      </div>
      {workflow === "ready_on_send" ? (
        <p className="text-sm text-muted-foreground">اقلام جدید صندوق با وضعیت آماده ثبت می‌شوند. پرداخت در بخش سفارش‌ها انجام می‌شود.</p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        بایگانی خودکار با روز کاری این شعبه هم‌گام است: با گذشتن روز کاری سفارش
        (بستن روز، یا آغاز روز بعد در ساعت تنظیم‌شدهٔ همین شعبه)، اقلام بازماندهٔ
        آن روز از صف آشپزخانه خارج می‌شوند؛ وضعیت سفارش و پرداخت تغییر نمی‌کند.
      </p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </SectionCard>
  );
}
