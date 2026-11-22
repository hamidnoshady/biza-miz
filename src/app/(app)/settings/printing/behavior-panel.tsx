"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { DOC_TYPE_LABELS } from "@/lib/print-template";
import { LEGACY_PRINT_BEHAVIOR, PRINT_POLICY_KEYS, type PrintBehavior, type PrintMode, type PrintNotifications, type PrintPolicy } from "@/lib/printing/behavior";

const labels = {
  ...DOC_TYPE_LABELS,
  accounting_document: "سند حسابداری",
  inventory_document: "سند انبار",
  report: "گزارش",
  contract: "قرارداد",
};

type State = { defaults: PrintPolicy; overrides: PrintPolicy; canEditDefaults: boolean; error?: string };

export function PrintBehaviorPanel() {
  const [server, setServer] = useState<State | null>(null);
  const [scope, setScope] = useState<"branch" | "business">("branch");
  const [policy, setPolicy] = useState<PrintPolicy>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<State>("/api/settings/print-behavior", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setFailure(errorMessage(result.data.error));
        return;
      }
      setServer(result.data);
      setPolicy(result.data.overrides);
    });
    return () => controller.abort();
  }, []);

  async function save() {
    setSaving(true);
    setFailure("");
    setMessage("");
    try {
      const result = await api<State>("/api/settings/print-behavior", {
        method: "PUT",
        body: JSON.stringify({ policy, scope }),
      });
      if (!result.ok) {
        setFailure(errorMessage(result.data.error));
        return;
      }
      setServer(result.data);
      setPolicy(scope === "branch" ? result.data.overrides : result.data.defaults);
      setMessage("تنظیمات چاپ ذخیره شد.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="رفتار چاپ و اعلان‌ها">
      {failure ? <p role="alert" className="text-sm text-destructive">{failure}</p> : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {server ? (
        <div className="space-y-4">
          {server.canEditDefaults ? (
            <label className="block text-sm">
              محدودهٔ تنظیمات
              <select className={inputClass} value={scope} disabled={saving} onChange={(event) => {
                const next = event.currentTarget.value === "business" ? "business" : "branch";
                setScope(next);
                setPolicy(next === "branch" ? server.overrides : server.defaults);
                setMessage("");
              }}>
                <option value="branch">این شعبه</option>
                <option value="business">پیش‌فرض کسب‌وکار</option>
              </select>
            </label>
          ) : null}
          <div className="space-y-3">
            {PRINT_POLICY_KEYS.map((type) => {
              const inherited = (scope === "branch" ? server.defaults[type] : undefined) ?? LEGACY_PRINT_BEHAVIOR;
              const current = policy[type] ?? inherited;
              const update = (behavior: PrintBehavior) => setPolicy((previous) => ({ ...previous, [type]: behavior }));
              return (
                <fieldset key={type} className="flex flex-wrap items-end gap-3 border-b border-border pb-3" disabled={saving}>
                  <legend className="text-sm font-semibold">{labels[type]}</legend>
                  <label className="text-sm">
                    روش چاپ
                    <select className={inputClass} value={current.mode}
                      onChange={(event) => update({ ...current, mode: event.currentTarget.value as PrintMode })}>
                      <option value="automatic">خودکار در صورت پشتیبانی</option>
                      <option value="manual">فقط دستی</option>
                      <option value="disabled">غیرفعال</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    اعلان‌های چاپ خودکار
                    <select className={inputClass} value={current.notifications}
                      onChange={(event) => update({ ...current, notifications: event.currentTarget.value as PrintNotifications })}>
                      <option value="all">همه</option>
                      <option value="failures">فقط خطاها</option>
                      <option value="off">خاموش</option>
                    </select>
                  </label>
                  {policy[type] ? (
                    <Button type="button" variant="outline" onClick={() => setPolicy((previous) => {
                      const next = { ...previous };
                      delete next[type];
                      return next;
                    })}>
                      بازگشت به پیش‌فرض
                    </Button>
                  ) : null}
                </fieldset>
              );
            })}
          </div>
          <Button type="button" disabled={saving} onClick={() => void save()}>ذخیره تنظیمات چاپ</Button>
        </div>
      ) : failure ? null : <p role="status">در حال دریافت تنظیمات…</p>}
    </SectionCard>
  );
}
