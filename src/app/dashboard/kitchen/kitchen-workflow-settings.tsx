"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { KitchenWorkflow } from "@/lib/kitchen-workflow";
import { SectionCard } from "../page-chrome";
import { api, errorMessage, inputClass } from "../ui";

type Response = { workflow?: KitchenWorkflow; error?: string };

export function KitchenWorkflowSettings() {
  const [workflow, setWorkflow] = useState<KitchenWorkflow>("kitchen_team");
  const [saved, setSaved] = useState<KitchenWorkflow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api<Response>("/api/kitchen/workflow", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok && result.data.workflow) {
        setWorkflow(result.data.workflow);
        setSaved(result.data.workflow);
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
        body: JSON.stringify({ workflow }),
      });
      if (!result.ok || !result.data.workflow) {
        setError(errorMessage(result.data.error));
        return;
      }
      setSaved(result.data.workflow);
      toast.success("روش آماده‌سازی سفارش‌های این شعبه ذخیره شد.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard>
      <h2 className="font-semibold">آماده‌سازی سفارش‌های این شعبه</h2>
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
        <Button type="button" disabled={busy || saved === null || saved === workflow} onClick={() => void save()}>
          ذخیره
        </Button>
      </div>
      {workflow === "ready_on_send" ? (
        <p className="text-sm text-muted-foreground">اقلام جدید صندوق با وضعیت آماده ثبت می‌شوند. پرداخت در بخش سفارش‌ها انجام می‌شود.</p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!error && saved === null ? <p role="status" className="text-sm">در حال دریافت تنظیمات…</p> : null}
    </SectionCard>
  );
}
