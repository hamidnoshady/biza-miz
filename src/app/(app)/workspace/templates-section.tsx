"use client";

/**
 * «قالب‌ها» — project blueprints.
 *
 * The catalogue is deliberately not restaurant-shaped: the built-ins cover
 * construction, architecture, software, marketing, events and consulting, and
 * a business can define its own phases for anything they are not. Built-ins
 * live in code (`BUILTIN_TEMPLATES`) so every tenant has them without seeding;
 * saving a template with a built-in's key overrides it for this business only,
 * which is why the built-in rows show a «پیش‌فرض» badge rather than a delete
 * button.
 */

import { useCallback, useEffect, useState } from "react";
import { LayoutTemplateIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
  cardClass,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { BUILTIN_TEMPLATES, type WorkspaceTemplate } from "@/lib/workspace-shared";
import {
  workspaceError,
  WorkspaceFormDialog,
} from "./workspace-ui";

const BUILTIN_KEYS = new Set(BUILTIN_TEMPLATES.map((t) => t.key));

export function TemplatesSection({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<WorkspaceTemplate[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<WorkspaceTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ templates: WorkspaceTemplate[] }>("/api/workspace/templates").then(({ ok, data }) => {
      if (ok) setTemplates(data.templates);
      else setError(workspaceError((data as unknown as { error?: string }).error));
    });
  }, []);

  useEffect(load, [load]);

  async function archive(key: string) {
    if (busy) return;
    setBusy(true);
    const { ok, data } = await api<{ templates: WorkspaceTemplate[] }>(
      `/api/workspace/templates?key=${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (ok) setTemplates(data.templates);
    else setError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard
        title="قالب‌های پروژه"
        description="فازهای آمادهٔ هر نوع کار — ساختمانی، معماری، نرم‌افزار، بازاریابی — که هنگام ساخت پروژه اعمال می‌شوند. قالب دلخواه خودتان را هم می‌توانید بسازید."
        actions={
          canManage ? (
            <PrimaryButton type="button" onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" aria-hidden />
              قالب جدید
            </PrimaryButton>
          ) : null
        }
        flush
      >
        {templates === null ? (
          <LoadingSkeleton rows={5} label="در حال بارگذاری قالب‌ها" />
        ) : templates.length === 0 ? (
          <EmptyState icon={LayoutTemplateIcon} title="قالبی تعریف نشده است">
            یک قالب بسازید تا پروژه‌های بعدی با فازهای آمادهٔ همان نوع کار شروع شوند.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => {
              const builtin = BUILTIN_KEYS.has(template.key);
              return (
                <li key={template.key} className={`${cardClass} flex flex-col gap-2 p-4`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{template.name}</h3>
                      <p className="text-xs text-muted-foreground">{template.description}</p>
                    </div>
                    <StatusBadge tone={builtin ? "neutral" : "active"}>
                      {builtin ? "پیش‌فرض" : "این کسب‌وکار"}
                    </StatusBadge>
                  </div>

                  <ol className="flex flex-col gap-1">
                    {template.phases.map((phase, index) => (
                      <li
                        key={`${template.key}-${phase.name}-${index}`}
                        className="flex items-baseline gap-2 text-xs"
                      >
                        <span className="tabular-nums text-muted-foreground">
                          {toPersianDigits(String(index + 1))}.
                        </span>
                        <span className="min-w-0 flex-1 truncate">{phase.name}</span>
                        {phase.durationDays ? (
                          <span className="tabular-nums text-muted-foreground">
                            {toPersianDigits(String(phase.durationDays))} روز
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>

                  {template.defaultTasks.length ? (
                    <p className="text-xs text-muted-foreground">
                      {toPersianDigits(String(template.defaultTasks.length))} وظیفهٔ آغازین
                    </p>
                  ) : null}

                  {canManage ? (
                    <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                      <SecondaryButton onClick={() => setEditing(template)}>
                        {builtin ? "ساخت نسخهٔ اختصاصی" : "ویرایش"}
                      </SecondaryButton>
                      {builtin ? null : (
                        <SecondaryButton onClick={() => archive(template.key)} disabled={busy}>
                          <Trash2Icon className="size-4" aria-hidden />
                          <span className="sr-only">بایگانی {template.name}</span>
                        </SecondaryButton>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {creating || editing ? (
        <TemplateDialog
          template={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(next) => {
            setTemplates(next);
            setCreating(false);
            setEditing(null);
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function TemplateDialog({
  template,
  onClose,
  onSaved,
  onError,
}: {
  template: WorkspaceTemplate | null;
  onClose: () => void;
  onSaved: (templates: WorkspaceTemplate[]) => void;
  onError: (message: string) => void;
}) {
  const builtin = template ? BUILTIN_KEYS.has(template.key) : false;
  const [name, setName] = useState(template ? (builtin ? `${template.name} (اختصاصی)` : template.name) : "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [projectType, setProjectType] = useState(template?.projectType ?? "");
  // Phases and starter tasks are edited as one-per-line text: a repeatable
  // row editor would be a new UI pattern for a list this short.
  const [phases, setPhases] = useState((template?.phases ?? []).map((p) => p.name).join("\n"));
  const [tasks, setTasks] = useState((template?.defaultTasks ?? []).join("\n"));
  const [saving, setSaving] = useState(false);

  const phaseNames = phases
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  async function submit() {
    if (!name.trim() || !phaseNames.length || saving) return;
    setSaving(true);
    const { ok, data } = await api<{ templates: WorkspaceTemplate[] }>("/api/workspace/templates", {
      method: "POST",
      body: JSON.stringify({
        // A built-in edited here becomes a NEW business template rather than a
        // silent override of the shared one, unless the user keeps its key.
        key: template && !builtin ? template.key : undefined,
        name,
        description,
        projectType: projectType || null,
        phases: phaseNames.map((phaseName) => ({ name: phaseName })),
        defaultTasks: tasks
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      }),
    });
    setSaving(false);
    if (ok) onSaved(data.templates);
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <WorkspaceFormDialog title={template ? (builtin ? "نسخهٔ اختصاصی از قالب" : "ویرایش قالب") : "قالب جدید"} width="xl" onClose={onClose}>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="نام قالب">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="نوع پروژه" hint="مثلاً ساختمانی، نرم‌افزاری — اختیاری">
          <input
            className={inputClass}
            value={projectType}
            onChange={(e) => setProjectType(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="توضیح">
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="فازها" hint="هر خط یک فاز، به ترتیب اجرا">
            <textarea
              className={`${inputClass} min-h-32`}
              value={phases}
              onChange={(e) => setPhases(e.target.value)}
              placeholder={"طراحی\nاجرا\nتحویل"}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="وظیفه‌های آغازین" hint="هر خط یک وظیفه — هنگام اعمال قالب ساخته می‌شوند">
            <textarea
              className={`${inputClass} min-h-24`}
              value={tasks}
              onChange={(e) => setTasks(e.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/80 p-4">
        <span className="text-xs text-muted-foreground">
          {toPersianDigits(String(phaseNames.length))} فاز
        </span>
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton
            type="button"
            onClick={submit}
            disabled={!name.trim() || !phaseNames.length || saving}
          >
            {saving ? "در حال ذخیره" : "ذخیرهٔ قالب"}
          </PrimaryButton>
        </div>
      </div>
    </WorkspaceFormDialog>
  );
}
