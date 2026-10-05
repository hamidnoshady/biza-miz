"use client";

/**
 * Issue #799 §22 — «ویجت‌های پیشنهادی»: the platform's recommended AI widgets.
 *
 * The console half of §22's last sentence. What lives here are the *offers*: one
 * row per industry (or «همهٔ کسب‌وکارها»), each with the prompt the assistant runs
 * when a member adds it. A member's own widgets are not visible from here and
 * cannot be touched from here — the widget catalogue is an offer list, and
 * `ai_widgets` belongs to the member who wrote it.
 *
 * Three deliberate choices on screen:
 *
 *   * **Retire, do not delete.** A recommendation somebody has already added is
 *     referenced by the widget it created; disabling it stops the offer and
 *     keeps that provenance. The button says «بازنشسته کردن», not «حذف».
 *   * **The permissions are checked in the open.** A recommendation asking for a
 *     key its intended audience lacks is offered to nobody, which looks like a
 *     bug from the tenant side, so the list prints each widget's permissions as
 *     chips rather than hiding them in the editor.
 *   * **The prompt is text, not power.** A prompt is executed under the *viewer's*
 *     own permissions (`runAecReadTool` and friends run as the member), so this
 *     page cannot widen anyone's access by writing a sentence — the header says
 *     so, because an operator should not have to guess.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheckIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { api, Button, Card, EmptyState, ErrorBox, Field, inputClass, selectClass, useCan } from "../../ui";

interface IndustryOption {
  value: string;
  label: string;
}

interface WidgetTemplate {
  id: string;
  name: string;
  description: string;
  industry: string;
  sourceApp: string;
  prompt: string;
  outputFormat: string;
  requiredPermissions: string[];
  defaultWidth: number;
  defaultHeight: number;
  enabled: boolean;
  createdBy: string | null;
  updatedAt: string;
}

interface Draft {
  id: string | null;
  name: string;
  description: string;
  industry: string;
  sourceApp: string;
  prompt: string;
  outputFormat: string;
  requiredPermissions: string;
  width: number;
  height: number;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  description: "",
  industry: "all",
  sourceApp: "workspace",
  prompt: "",
  outputFormat: "bullets",
  requiredPermissions: "workspace.view",
  width: 2,
  height: 1,
};

const OUTPUT_FORMAT_LABELS: Record<string, string> = {
  summary: "خلاصه",
  bullets: "بندبند",
  metric: "عدد",
};

const PERMISSION_LABELS: Record<string, string> = {
  "workspace.view": "مشاهدهٔ میز کار",
  "workspace.approve": "تأیید میز کار",
  "ledger.view": "مشاهدهٔ دفاتر",
  "ai.use": "استفاده از دستیار",
};

export default function PlatformAiWidgetsPage() {
  const can = useCan();
  const canManage = can("ai.config.manage");
  const [templates, setTemplates] = useState<WidgetTemplate[] | null>(null);
  const [industries, setIndustries] = useState<IndustryOption[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ templates: WidgetTemplate[]; industries: IndustryOption[] }>(
      "/api/platform/ai/widgets",
    );
    if (!ok) {
      setError("بارگذاری فهرست ویجت‌ها ناموفق بود.");
      setTemplates([]);
      return;
    }
    setTemplates(data.templates);
    setIndustries(data.industries);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byIndustry = useMemo(() => {
    const groups = new Map<string, WidgetTemplate[]>();
    for (const template of templates ?? []) {
      const list = groups.get(template.industry) ?? [];
      list.push(template);
      groups.set(template.industry, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [templates]);

  const labelFor = (industry: string) =>
    industries.find((option) => option.value === industry)?.label ?? industry;

  async function save() {
    if (!draft || busy) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setError("نام و متن پرسش لازم است.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ template: WidgetTemplate }>("/api/platform/ai/widgets", {
      method: "POST",
      body: JSON.stringify({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        industry: draft.industry,
        sourceApp: draft.sourceApp,
        prompt: draft.prompt,
        outputFormat: draft.outputFormat,
        requiredPermissions: draft.requiredPermissions
          .split(/[,\s]+/)
          .map((value) => value.trim())
          .filter(Boolean),
        width: draft.width,
        height: draft.height,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError("ذخیره نشد؛ نام، متن پرسش و صنعت را بررسی کنید.");
      return;
    }
    setNotice(draft.id ? "ویجت پیشنهادی به‌روز شد." : "ویجت پیشنهادی ساخته شد.");
    setDraft(null);
    await load();
  }

  async function toggle(template: WidgetTemplate) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok } = await api(`/api/platform/ai/widgets/${template.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !template.enabled }),
    });
    setBusy(false);
    if (!ok) {
      setError("تغییر وضعیت انجام نشد.");
      return;
    }
    setNotice(template.enabled ? "ویجت بازنشسته شد و دیگر پیشنهاد نمی‌شود." : "ویجت دوباره پیشنهاد می‌شود.");
    await load();
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700 dark:text-sky-300">
          <SparklesIcon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-xl font-bold">ویجت‌های پیشنهادی</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            ویجت‌هایی که به کسب‌وکارهای هر صنعت پیشنهاد می‌شوند. این‌ها فقط <em>پیشنهاد</em> هستند: کاربر
            می‌تواند آن‌ها را اضافه کند یا ویجت خودش را بنویسد. متن پرسش با دسترسی‌های همان کاربر اجرا
            می‌شود، پس این صفحه دسترسی کسی را باز نمی‌کند.
            {canManage ? "" : " (فقط مشاهده — تغییر در اختیار مدیر ارشد است.)"}
          </p>
        </div>
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <p className="mb-3 rounded-xl border border-border/80 bg-muted/40 p-3 text-sm">{notice}</p>
      ) : null}

      {canManage ? (
        <div className="mb-4">
          <Button onClick={() => setDraft(draft ? null : { ...EMPTY_DRAFT })}>
            <PlusIcon className="size-4" aria-hidden="true" />
            {draft ? "بستن فرم" : "ویجت پیشنهادی جدید"}
          </Button>
        </div>
      ) : null}

      {draft && canManage ? (
        <Card title={draft.id ? "ویرایش ویجت پیشنهادی" : "ویجت پیشنهادی جدید"}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="نام">
              <input
                className={inputClass}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="صنعت">
              <select
                className={selectClass}
                value={draft.industry}
                onChange={(event) => setDraft({ ...draft, industry: event.target.value })}
              >
                {industries.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="توضیح کوتاه">
              <input
                className={inputClass}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>
            <Field label="برنامهٔ مبدأ">
              <input
                className={inputClass}
                value={draft.sourceApp}
                onChange={(event) => setDraft({ ...draft, sourceApp: event.target.value })}
              />
            </Field>
            <Field label="شکل نمایش">
              <select
                className={selectClass}
                value={draft.outputFormat}
                onChange={(event) => setDraft({ ...draft, outputFormat: event.target.value })}
              >
                {Object.entries(OUTPUT_FORMAT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="مجوزهای لازم (با فاصله یا کاما)">
              <input
                className={inputClass}
                value={draft.requiredPermissions}
                onChange={(event) => setDraft({ ...draft, requiredPermissions: event.target.value })}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="متن پرسش">
              <textarea
                className={`${inputClass} min-h-32`}
                value={draft.prompt}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              />
            </Field>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button onClick={save}>{busy ? "در حال ذخیره…" : "ذخیره"}</Button>
            <Button onClick={() => setDraft(null)}>انصراف</Button>
          </div>
        </Card>
      ) : null}

      {!templates ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : templates.length === 0 ? (
        <EmptyState title="هنوز ویجتی پیشنهاد نشده است" hint="با «ویجت پیشنهادی جدید» اولین پیشنهاد این صنعت را بسازید." />
      ) : (
        <div className="flex flex-col gap-4">
          {byIndustry.map(([industry, list]) => (
            <Card key={industry} title={labelFor(industry)}>
              <ul className="flex flex-col divide-y divide-border/80">
                {list.map((template) => (
                  <li key={template.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{template.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {OUTPUT_FORMAT_LABELS[template.outputFormat] ?? template.outputFormat}
                      </span>
                      {template.enabled ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                          <BadgeCheckIcon className="size-3.5" aria-hidden="true" />
                          پیشنهاد می‌شود
                        </span>
                      ) : (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          بازنشسته
                        </span>
                      )}
                      {template.requiredPermissions.map((permission) => (
                        <span
                          key={permission}
                          className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {PERMISSION_LABELS[permission] ?? permission}
                        </span>
                      ))}
                    </div>
                    {template.description ? (
                      <p className="text-sm text-muted-foreground">{template.description}</p>
                    ) : null}
                    <p className="text-xs leading-6 text-muted-foreground">{template.prompt}</p>
                    {canManage ? (
                      <div className="flex gap-2">
                        <Button
                          onClick={() =>
                            setDraft({
                              id: template.id,
                              name: template.name,
                              description: template.description,
                              industry: template.industry,
                              sourceApp: template.sourceApp,
                              prompt: template.prompt,
                              outputFormat: template.outputFormat,
                              requiredPermissions: template.requiredPermissions.join(", "),
                              width: template.defaultWidth,
                              height: template.defaultHeight,
                            })
                          }
                        >
                          ویرایش
                        </Button>
                        <Button onClick={() => toggle(template)}>
                          {template.enabled ? "بازنشسته کردن" : "پیشنهاد دوباره"}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
