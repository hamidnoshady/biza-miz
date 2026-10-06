"use client";

/**
 * Issue #812 §5/§6 — the Deep Research platform console.
 *
 * Every cap on this page is a ceiling the workflow enforces server-side, not a
 * default the UI suggests: enabled/disabled, the LiteLLM alias, max context,
 * max rounds, environment TTL, max spend per run, minimum data readiness and
 * the external-web policy. A tenant cannot change any of them, and the chat
 * route refuses a `deep_research` turn outright while `enabled` is false.
 */
import { useCallback, useEffect, useState } from "react";
import { api, Button, Card, Field, InfoBox, inputClass, useCan } from "../../ui";
import { AiConsoleNav } from "../ai-console-nav";

interface ResearchSettings {
  enabled: boolean;
  modelAlias: string;
  maxRounds: number;
  maxContextBytes: number;
  ttlHours: number;
  maxSpendRial: number;
  minDataReadiness: number;
  externalWeb: boolean;
}

const DEFAULTS: ResearchSettings = {
  enabled: false,
  modelAlias: "",
  maxRounds: 4,
  maxContextBytes: 2_000_000,
  ttlHours: 24,
  maxSpendRial: 0,
  minDataReadiness: 1,
  externalWeb: false,
};

export default function PlatformAiResearchPage() {
  const canManage = useCan()("ai.config.manage");
  const [settings, setSettings] = useState<ResearchSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ settings: ResearchSettings }>("/api/platform/ai/research");
    if (ok) setSettings({ ...DEFAULTS, ...data.settings });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    const { ok, data } = await api<{ error?: string }>("/api/platform/ai/research", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    setSaving(false);
    if (!ok) {
      alert(data.error ?? "ذخیره نشد");
      return;
    }
    void load();
  }

  if (loading) return <p className="text-sm text-muted-foreground">در حال خواندن…</p>;

  return (
    <div className="space-y-4">
      <AiConsoleNav />
      <InfoBox>
        پژوهش عمیق یک کار جداگانه و هزینه‌دار است: محیط اختصاصی خودش را دارد، سقف هزینهٔ هر اجرا را بعد از هر دور
        بررسی می‌کند، منقضی می‌شود و نتیجه را همراه منابع نگه می‌دارد. تا وقتی «فعال» خاموش است، حالت پژوهش عمیق
        به کاربر پیشنهاد هم نمی‌شود.
      </InfoBox>

      <Card title="سوءّیت و سقف‌ها">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نامشاپ لایت‌ال‌ال‌ام">
            <input
              className={inputClass}
              dir="ltr"
              value={settings.modelAlias}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, modelAlias: event.target.value })}
              placeholder="pos-deep-research"
            />
          </Field>
          <Field label="حداکثر دورهای بررسی (۱ تا ۱۲)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={settings.maxRounds}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, maxRounds: Number(event.target.value) })}
            />
          </Field>
          <Field label="حداکثر حجم زمینه (بایت)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={settings.maxContextBytes}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, maxContextBytes: Number(event.target.value) })}
            />
          </Field>
          <Field label="عمر محیط (ساعت)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={settings.ttlHours}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, ttlHours: Number(event.target.value) })}
            />
          </Field>
          <Field label="سقف هزینهٔ هر اجرا (ریال)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={settings.maxSpendRial}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, maxSpendRial: Number(event.target.value) })}
            />
          </Field>
          <Field label="حداقل آمادگی داده (۱ تا ۵)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={settings.minDataReadiness}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, minDataReadiness: Number(event.target.value) })}
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
            فعال
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.externalWeb}
              disabled={!canManage}
              onChange={(event) => setSettings({ ...settings, externalWeb: event.target.checked })}
            />
            جست‌وجوی وب خارجی مجاز است
          </label>
          {canManage ? (
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? "در حال ذخیره…" : "ذخیره"}
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
