"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { DEFAULT_UI_INTERACTION_SETTINGS, type UiInteractionSettings } from "@/lib/ui-interaction-settings";

export function UiInteractionSettingsPanel() {
  const [value, setValue] = useState<UiInteractionSettings>(DEFAULT_UI_INTERACTION_SETTINGS);
  const [initial, setInitial] = useState<UiInteractionSettings>(DEFAULT_UI_INTERACTION_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ settings: UiInteractionSettings; error?: string }>("/api/settings/ui-interaction");
    if (ok) { setValue(data.settings); setInitial(data.settings); setError(""); }
    else setError(errorMessage(data.error));
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  function patch(next: Partial<UiInteractionSettings>) { setSaved(false); setValue((current) => ({ ...current, ...next })); }
  async function save(reset = false) {
    setSaving(true); setError(""); setSaved(false);
    const { ok, data } = await api<{ settings?: UiInteractionSettings; error?: string }>("/api/settings/ui-interaction", {
      method: "PUT", body: JSON.stringify(reset ? { resetToDefaults: true } : { settings: value }),
    });
    setSaving(false);
    if (!ok || !data.settings) { setError(errorMessage(data.error)); return; }
    setValue(data.settings); setInitial(data.settings); setSaved(true);
    window.dispatchEvent(new CustomEvent("ui-interaction-settings-changed", { detail: data.settings }));
    try { window.localStorage.setItem("ui.interaction.updated", JSON.stringify(data.settings)); } catch { /* policy remains server-authoritative */ }
  }

  if (loading) return <div role="status" aria-busy="true" className="ops-skeleton h-40 rounded-2xl" />;
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  return <div className="space-y-4">
    <ErrorBox>{error}</ErrorBox>{saved ? <InfoBox>تنظیمات تعاملات ذخیره شد و برای نشست‌های بعدی نیز اعمال می‌شود.</InfoBox> : null}
    <SectionCard title="عملیات و ژست‌ها" description="سیاست پیش‌فرض کسب‌وکار برای ژست‌های پایانهٔ فروش. این تنظیمات هرگز مجوز پرداخت، اعتبارسنجی سرور یا کنترل‌های مالی را دور نمی‌زنند.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="تأیید پرداخت">
          <select className={inputClass} value={value.paymentConfirmation} onChange={(e) => patch({ paymentConfirmation: e.target.value as UiInteractionSettings["paymentConfirmation"] })}>
            <option value="hold">نگه‌داشتن برای تأیید (پیش‌فرض)</option>
            <option value="confirm-dialog">یک‌بار لمس + پنجرهٔ تأیید</option>
          </select>
        </Field>
        <Field label="مدت نگه‌داشتن پرداخت" hint="بین ۱ تا ۵ ثانیه؛ تنها در حالت نگه‌داشتن استفاده می‌شود.">
          <input className={inputClass} type="number" min={1000} max={5000} step={250} value={value.paymentHoldMs} onChange={(e) => patch({ paymentHoldMs: Number(e.target.value) })} />
        </Field>
        <Field label="افزودن افزودنی">
          <select className={inputClass} value={value.addOnMode} onChange={(e) => patch({ addOnMode: e.target.value as UiInteractionSettings["addOnMode"] })}>
            <option value="hold-repeat">نگه‌داشتن برای تکرار (پیش‌فرض)</option>
            <option value="buttons">فقط دکمه‌های + و −</option>
          </select>
        </Field>
        <Field label="بازهٔ تکرار نگه‌داشتن" hint="بین ۵۰۰ تا ۴۰۰۰ میلی‌ثانیه.">
          <input className={inputClass} type="number" min={500} max={4000} step={100} value={value.addOnHoldMs} onChange={(e) => patch({ addOnHoldMs: Number(e.target.value) })} />
        </Field>
        <Field label="پنجرهٔ تشخیص دوبار لمس" hint="محدودهٔ مجاز: ۲۰۰ تا ۸۰۰ میلی‌ثانیه.">
          <input className={inputClass} type="number" min={200} max={800} step={20} value={value.doubleTapWindowMs} onChange={(e) => patch({ doubleTapWindowMs: Number(e.target.value) })} />
        </Field>
      </div>
      <label className="mt-4 flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={value.doubleTapEnabled} onChange={(e) => patch({ doubleTapEnabled: e.target.checked })} />کاهش تعداد با دوبار لمس سریع</label>
    </SectionCard>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}</Button>
      <Button type="button" variant="outline" onClick={() => void save(true)} disabled={saving}>بازنشانی به پیش‌فرض</Button>
      <p className="text-xs text-muted-foreground">نسخهٔ سیاست: {value.version} · تنظیم فقط برای مدیران تنظیمات فعال است.</p>
    </div>
  </div>;
}
