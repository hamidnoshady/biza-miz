"use client";

/**
 * Superadmin runtime-mode settings: Persian-first, clearable overrides and
 * truthful persistence feedback. LiteLLM still owns upstream routing, budgets,
 * retries and model deployments; this page only selects an existing alias.
 */
import { useCallback, useEffect, useState } from "react";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, useCan } from "../../ui";
import { AiConsoleNav } from "../ai-console-nav";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  AI_MODE_HINTS,
  AI_MODE_LABELS,
  AI_CHAT_MODES,
  type AiRuntimeMode,
} from "@/lib/ai-runtime-modes-shared";

interface ModeRow {
  mode: AiRuntimeMode;
  modelAlias: string;
  isActive: boolean;
  temperature: number | null;
  maxOutputTokens: number | null;
  promptScopeKey: string;
  updatedBy: string;
}

interface ModeDraft extends Omit<ModeRow, "temperature" | "maxOutputTokens"> {
  temperatureInput: string;
  maxOutputTokensInput: string;
}

interface ModesResponse {
  modes?: ModeRow[];
  mode?: ModeRow;
  defaultChatModel?: string;
  availableModelAliases?: string[];
  error?: string;
}

function toDraft(row: ModeRow): ModeDraft {
  return {
    mode: row.mode,
    modelAlias: row.modelAlias,
    isActive: row.isActive,
    temperatureInput: row.temperature === null ? "" : String(row.temperature),
    maxOutputTokensInput: row.maxOutputTokens === null ? "" : String(row.maxOutputTokens),
    promptScopeKey: row.promptScopeKey,
    updatedBy: row.updatedBy,
  };
}

function modeError(code?: string): string {
  switch (code) {
    case "mode_unknown": return "حالت اجرای انتخاب‌شده شناخته نشد.";
    case "mode_temperature_invalid": return "مقدار دما معتبر نیست.";
    case "mode_tokens_invalid": return "تعداد توکن‌های خروجی معتبر نیست.";
    case "mode_update_failed": return "ذخیره تنظیمات ناموفق بود. نام مستعار مدل و محدودیت‌های عددی را بررسی کنید.";
    case "forbidden": return "مجوز تغییر تنظیمات هوش مصنوعی را ندارید.";
    default: return "ارتباط با سرور یا ذخیره تنظیمات ناموفق بود. دوباره تلاش کنید.";
  }
}

function validateDraft(row: ModeDraft): string | null {
  const alias = row.modelAlias.trim();
  if (alias.length > 120 || /[^\w.:/-]/.test(alias)) {
    return "نام مستعار باید حداکثر ۱۲۰ نویسه باشد و فقط شامل حروف لاتین، عدد، خط تیره، نقطه، دونقطه، اسلش یا زیرخط باشد.";
  }
  if (row.temperatureInput.trim() !== "") {
    const temperature = Number(row.temperatureInput);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return "دما باید عددی بین ۰ و ۲ باشد.";
    }
  }
  if (row.maxOutputTokensInput.trim() !== "") {
    const tokens = Number(row.maxOutputTokensInput);
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > 200000) {
      return "حداکثر توکن خروجی باید یک عدد صحیح بین ۱ تا ۲۰۰٬۰۰۰ باشد.";
    }
  }
  return null;
}

export default function PlatformAiModesPage() {
  const canManage = useCan()("ai.config.manage");
  const [modes, setModes] = useState<ModeDraft[]>([]);
  const [savedModes, setSavedModes] = useState<ModeRow[]>([]);
  const [availableAliases, setAvailableAliases] = useState<string[]>([]);
  const [defaultChatModel, setDefaultChatModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<AiRuntimeMode | null>(null);
  const [pageError, setPageError] = useState("");
  const [modeErrors, setModeErrors] = useState<Partial<Record<AiRuntimeMode, string>>>({});
  const [successMode, setSuccessMode] = useState<AiRuntimeMode | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api<ModesResponse>("/api/platform/ai/modes");
    if (result.ok) {
      const rows = result.data.modes ?? [];
      setSavedModes(rows);
      setModes(rows.map(toDraft));
      setAvailableAliases(result.data.availableModelAliases ?? []);
      setDefaultChatModel(result.data.defaultChatModel ?? "");
      setPageError("");
    } else {
      setPageError(modeError(result.data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function change(mode: AiRuntimeMode, patch: Partial<ModeDraft>) {
    setModes((current) => current.map((row) => row.mode === mode ? { ...row, ...patch } : row));
    setModeErrors((current) => ({ ...current, [mode]: "" }));
    setSuccessMode(null);
  }

  function isDirty(row: ModeDraft): boolean {
    const original = savedModes.find((entry) => entry.mode === row.mode);
    if (!original) return false;
    return row.modelAlias !== original.modelAlias ||
      row.isActive !== original.isActive ||
      row.temperatureInput !== (original.temperature === null ? "" : String(original.temperature)) ||
      row.maxOutputTokensInput !== (original.maxOutputTokens === null ? "" : String(original.maxOutputTokens));
  }

  async function save(row: ModeDraft) {
    const validation = validateDraft(row);
    if (validation) {
      setModeErrors((current) => ({ ...current, [row.mode]: validation }));
      return;
    }
    setSaving(row.mode);
    setPageError("");
    const result = await api<ModesResponse>("/api/platform/ai/modes", {
      method: "PUT",
      body: JSON.stringify({
        mode: row.mode,
        modelAlias: row.modelAlias.trim(),
        isActive: row.isActive,
        temperature: row.temperatureInput.trim() === "" ? null : Number(row.temperatureInput),
        maxOutputTokens: row.maxOutputTokensInput.trim() === "" ? null : Number(row.maxOutputTokensInput),
      }),
    });
    setSaving(null);
    if (!result.ok || !result.data.mode) {
      setModeErrors((current) => ({ ...current, [row.mode]: modeError(result.data.error) }));
      return;
    }
    const saved = result.data.mode;
    setSavedModes((current) => current.map((entry) => entry.mode === row.mode ? saved : entry));
    setModes((current) => current.map((entry) => entry.mode === row.mode ? toDraft(saved) : entry));
    setModeErrors((current) => ({ ...current, [row.mode]: "" }));
    setSuccessMode(row.mode);
  }

  function revert(key: AiRuntimeMode) {
    const original = savedModes.find((entry) => entry.mode === key);
    if (original) change(key, toDraft(original));
  }

  return (
    <div className="space-y-4" dir="rtl">
      <AiConsoleNav />
      <div className="space-y-1">
        <h1 className="text-xl font-bold text-foreground">حالت‌های اجرای دستیار هوش مصنوعی</h1>
        <p className="text-sm text-muted-foreground">
          برای هر حالت، مدل و تنظیمات پاسخ را مشخص کنید. تغییرات هر حالت جداگانه ذخیره می‌شود.
        </p>
      </div>
      <InfoBox>
        نام مستعار مدل را از مدل‌های ثبت‌شده در LiteLLM انتخاب کنید. خالی گذاشتن آن یعنی استفاده از مدل پیش‌فرض دروازه.
        دما و سقف توکن در صورت خالی بودن از تنظیمات پیش‌فرض استفاده می‌کنند.
        مدیریت ارائه‌دهندگان، مسیریابی و محدودیت‌های LiteLLM در این صفحه انجام نمی‌شود.
      </InfoBox>
      {pageError ? <ErrorBox>{pageError}</ErrorBox> : null}
      {loading ? (
        <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground" role="status">در حال دریافت تنظیمات…</div>
      ) : modes.length === 0 ? (
        <div className="rounded-xl border border-border p-5">
          <p className="mb-3 text-sm text-muted-foreground">تنظیمات حالت‌های اجرا در دسترس نیست.</p>
          <Button onClick={() => void load()}>تلاش دوباره</Button>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {AI_CHAT_MODES.map((key) => {
            const row = modes.find((item) => item.mode === key);
            if (!row) return null;
            const busy = saving !== null;
            const dirty = isDirty(row);
            const alias = row.modelAlias.trim();
            const unknownAlias = availableAliases.length > 0 && alias !== "" && !availableAliases.includes(alias);
            const effectiveAlias = alias || defaultChatModel;
            return (
              <Card key={key} title={AI_MODE_LABELS[key]}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">{AI_MODE_HINTS[key]}</p>
                  <span className={"rounded-full px-2 py-1 text-xs " + (row.isActive ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>
                    {row.isActive ? "فعال" : "غیرفعال"}
                  </span>
                </div>
                <div className="mt-4 space-y-2">
                  <Field label="نام مستعار مدل در LiteLLM" hint="در صورت خالی بودن، مدل پیش‌فرض دروازه استفاده می‌شود.">
                    <input
                      className={inputClass}
                      dir="ltr"
                      autoComplete="off"
                      list={"ai-mode-aliases-" + key}
                      value={row.modelAlias}
                      disabled={!canManage || busy}
                      onChange={(event) => change(key, { modelAlias: event.target.value })}
                      placeholder={defaultChatModel || "نام مستعار مدل"}
                    />
                    <datalist id={"ai-mode-aliases-" + key}>
                      {availableAliases.map((item) => <option key={item} value={item} />)}
                    </datalist>
                  </Field>
                  <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">مدل مؤثر: </span>
                    <span dir="ltr" className="inline-block font-medium">{effectiveAlias || "تنظیم نشده"}</span>
                    {!alias ? <span className="mr-2 text-xs text-muted-foreground">(پیش‌فرض)</span> : null}
                  </div>
                  {unknownAlias ? <p className="text-xs text-amber-700 dark:text-amber-300" role="status">این نام مستعار در فهرست فعلی مدل‌های LiteLLM یافت نشد؛ قبل از استفاده، آن را بررسی کنید.</p> : null}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="دما" hint="بین ۰ و ۲؛ خالی = پیش‌فرض">
                    <PersianNumberInput
                      inputMode="decimal"
                      min="0"
                      max="2"
                      step="0.01"
                      className={inputClass}
                      dir="ltr"
                      value={row.temperatureInput}
                      disabled={!canManage || busy}
                      onChange={(event) => change(key, { temperatureInput: event.target.value })}
                      placeholder="پیش‌فرض"
                    />
                  </Field>
                  <Field label="حداکثر توکن خروجی" hint="عدد صحیح ۱ تا ۲۰۰٬۰۰۰؛ خالی = پیش‌فرض">
                    <PersianNumberInput
                      inputMode="numeric"
                      min="1"
                      max="200000"
                      step="1"
                      className={inputClass}
                      dir="ltr"
                      value={row.maxOutputTokensInput}
                      disabled={!canManage || busy}
                      onChange={(event) => change(key, { maxOutputTokensInput: event.target.value })}
                      placeholder="پیش‌فرض"
                    />
                  </Field>
                </div>
                <details className="rounded-lg border border-border px-3 py-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">مشاهده جزئیات فنی حالت</summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    دامنه راهنمای سیستمی:
                    <code dir="ltr" className="mr-2 inline-block">{row.promptScopeKey}</code>
                  </p>
                </details>
                {modeErrors[key] ? <div className="mt-3" role="alert"><ErrorBox>{modeErrors[key]}</ErrorBox></div> : null}
                {successMode === key && !dirty ? <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300" role="status">تنظیمات این حالت با موفقیت ذخیره شد.</p> : null}
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={row.isActive}
                      disabled={!canManage || busy}
                      onChange={(event) => change(key, { isActive: event.target.checked })}
                    />
                    فعال‌سازی حالت
                  </label>
                  <div className="flex-1" />
                  {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">تغییرات ذخیره‌نشده</span>}
                  {canManage && dirty ? <Button variant="ghost" disabled={busy} onClick={() => revert(key)}>انصراف</Button> : null}
                  {canManage ? (
                    <Button disabled={busy || !dirty} onClick={() => void save(row)}>
                      {saving === key ? "در حال ذخیره…" : "ذخیره تغییرات"}
                    </Button>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
