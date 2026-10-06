"use client";

/**
 * Issue #812 §10 — «حافظهٔ دستیار», the tenant side of layered memory.
 *
 * What this panel is: the durable facts and preferences this business wants
 * the assistant to remember — at the business, app and project level. What it
 * is NOT: a document index, an embedding control, or a reindex button. Those
 * belonged to the local RAG stack the issue retires; knowledge retrieval is now
 * infrastructure owned by the configured AI layer, and nothing a tenant can do
 * here changes how it retrieves.
 *
 * Two things the panel makes obvious rather than hiding:
 *
 *  - **Where an entry sits.** Business-wide, one app, or one project — the
 *    scope is chosen, not inferred, because it decides who the entry reaches.
 *  - **That an entry is deletable, and stays deleted.** Removing one is a soft
 *    delete and every read filters it out, so it stops influencing future turns
 *    immediately (§10's "deleted memory must stop influencing future turns").
 */
import { useCallback, useEffect, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { Field, InfoBox, api, inputClass } from "@/app/dashboard/ui";
import type { MemoryScope } from "@/lib/ai-memory";

const SCOPE_LABELS: Record<MemoryScope, string> = {
  platform: "پلتفرم",
  tenant: "کسب‌وکار",
  app: "بخش",
  project: "پروژه",
};

/** The four standalone apps, in the product's own vocabulary. */
const APP_OPTIONS: { key: string; label: string }[] = [
  { key: "accounting", label: "حسابداری" },
  { key: "crm", label: "مشتریان" },
  { key: "growth", label: "رشد" },
  { key: "website", label: "وب‌سایت" },
];

interface MemoryEntryView {
  id: string;
  scope: MemoryScope;
  appKey: string | null;
  projectId: string | null;
  content: string;
  source: string;
  updatedAt: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

export function AiMemoryPanel() {
  const [scope, setScope] = useState<MemoryScope>("tenant");
  const [appKey, setAppKey] = useState(APP_OPTIONS[0].key);
  const [projectId, setProjectId] = useState("");
  const [entries, setEntries] = useState<MemoryEntryView[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [maxChars, setMaxChars] = useState(4000);

  const params = useCallback(() => {
    const search = new URLSearchParams({ scope });
    if (scope === "app") search.set("appKey", appKey);
    if (scope === "project" && projectId) search.set("projectId", projectId);
    return search.toString();
  }, [scope, appKey, projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ entries: MemoryEntryView[]; maxChars: number }>(`/api/ai/memory?${params()}`);
    if (ok) {
      setEntries(data.entries ?? []);
      setMaxChars(data.maxChars ?? 4000);
    }
    setLoading(false);
  }, [params]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api<{ projects: ProjectOption[] }>("/api/ai/projects").then(({ ok, data }) => {
      if (ok) {
        setProjects(data.projects ?? []);
        if (data.projects?.[0] && !projectId) setProjectId(data.projects[0].id);
      }
    });
    // `projectId` is read only to avoid clobbering a member's own choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!draft.trim()) {
      toast.error("متن را وارد کنید.");
      return;
    }
    setSaving(true);
    const { ok, data } = await api<{ error?: string; entry?: MemoryEntryView }>("/api/ai/memory", {
      method: "POST",
      body: JSON.stringify({
        scope,
        appKey: scope === "app" ? appKey : undefined,
        projectId: scope === "project" ? projectId || undefined : undefined,
        content: draft.trim(),
      }),
    });
    setSaving(false);
    if (!ok) {
      toast.error(memoryErrorMessage(data.error ?? ""));
      return;
    }
    setDraft("");
    toast.success("به حافظهٔ دستیار اضافه شد.");
    void load();
  }

  async function remove(entry: MemoryEntryView) {
    if (!window.confirm("این مورد از حافظهٔ دستیار حذف شود؟")) return;
    setBusyId(entry.id);
    const { ok } = await api(`/api/ai/memory`, {
      method: "DELETE",
      body: JSON.stringify({
        id: entry.id,
        scope: entry.scope,
        projectId: entry.scope === "project" ? entry.projectId : undefined,
      }),
    });
    setBusyId(null);
    if (!ok) {
      toast.error("حذف نشد.");
      return;
    }
    toast.success("حذف شد و از این پس در پاسخ‌ها تأثیر نمی‌گذارد.");
    void load();
  }

  return (
    <div className="space-y-4">
      <InfoBox>
        آنچه اینجا ثبت کنید، در همهٔ گفت‌وگوهای بعدی دستیار به‌کار می‌رود: قواعد مالی کسب‌وکار، ترجیح‌های
        گزارش، نکاتی که همیشه باید رعایت شود. این بخش جای گذاشتن اسناد یا فایل نیست — آن‌ها را در «دانش» بخش
        مربوط نگه دارید.
      </InfoBox>

      <div className="flex flex-wrap gap-2">
        {(["tenant", "app", "project"] as MemoryScope[]).map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={scope === key ? "default" : "outline"}
            onClick={() => setScope(key)}
          >
            {SCOPE_LABELS[key]}
          </Button>
        ))}
      </div>

      {scope === "app" && (
        <div className="flex flex-wrap gap-2">
          {APP_OPTIONS.map((app) => (
            <Button
              key={app.key}
              type="button"
              size="sm"
              variant={appKey === app.key ? "default" : "outline"}
              onClick={() => setAppKey(app.key)}
            >
              {app.label}
            </Button>
          ))}
        </div>
      )}

      {scope === "project" && (
        <Field label="پروژه">
          <select className={inputClass} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">انتخاب کنید…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : entries.length === 0 ? (
        <EmptyState>هنوز چیزی ثبت نشده است.</EmptyState>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <SectionCard key={entry.id} title={SCOPE_LABELS[entry.scope]}>
              <div className="space-y-2">
                <p className="text-sm leading-6 text-foreground whitespace-pre-wrap">{entry.content}</p>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <StatusBadge tone="neutral">{entry.source === "user" ? "دستی" : entry.source}</StatusBadge>
                    {entry.appKey && <StatusBadge tone="neutral">{entry.appKey}</StatusBadge>}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-destructive hover:text-destructive"
                    disabled={busyId === entry.id}
                    onClick={() => remove(entry)}
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                    حذف
                  </Button>
                </div>
              </div>
            </SectionCard>
          ))}
        </div>
      )}

      <SectionCard title="ثبت مورد جدید">
        <div className="space-y-3">
          <Field label={`متن (حداکثر ${maxChars.toLocaleString("fa-IR")} نویسه)`}>
            <textarea
              className={inputClass}
              rows={4}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="مثلاً: صورت‌های مالی همیشه به تومان گزارش شود و مالیات بر ارزش افزوده ۹٪ محاسبه شود."
            />
          </Field>
          <div className="flex justify-end">
            <Button type="button" size="sm" className="gap-1.5" disabled={saving} onClick={create}>
              <PlusIcon className="size-4" aria-hidden="true" />
              افزودن
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

/** Persian messages for the service's own error codes. */
export function memoryErrorMessage(code: string): string {
  switch (code) {
    case "memory_content_required":
      return "متن خالی است.";
    case "memory_too_long":
      return "متن بلندتر از حد مجاز است.";
    case "memory_business_required":
      return "کسب‌وکار مشخص نیست.";
    case "memory_app_required":
      return "بخش را انتخاب کنید.";
    case "memory_project_required":
      return "پروژه را انتخاب کنید.";
    case "memory_tenant_scope_shape":
      return "حافظهٔ کسب‌وکار نباید به بخش یا پروژه گره خورده باشد.";
    case "memory_looks_like_a_secret":
      return "به نظر می‌رسد کلید یا رمزی در متن هست؛ چنین چیزی در حافظهٔ دستیار ذخیره نمی‌شود.";
    case "forbidden":
      return "به این پروژه دسترسی ندارید.";
    default:
      return "ثبت نشد.";
  }
}
