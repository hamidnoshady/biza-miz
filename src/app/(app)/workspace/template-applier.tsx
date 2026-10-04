"use client";

/**
 * «اعمال قالب» on a project (#761 §16): pick a recipe and a mode, see exactly
 * what will change, then apply. The preview is the server's dry run of the
 * same plan that then runs — so the list the member approved is the change
 * that lands. Merge adds only what is missing; replace also removes EMPTY
 * phases the recipe does not name. Tasks are never deleted.
 */

import { useEffect, useState } from "react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { TemplateApplyMode, TemplatePlan } from "@/lib/workspace-shared";
import { PickerField, workspaceError } from "./workspace-ui";

interface TemplateOption {
  key: string;
  name: string;
}

const MODE_LABELS: Record<TemplateApplyMode, string> = {
  merge: "افزودن موارد تازه (ادغام)",
  replace: "جایگزینی (فازهای خالیِ خارج از قالب حذف می‌شوند)",
};

export function TemplateApplier({ projectId, onApplied }: { projectId: string; onApplied: () => void }) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<TemplateApplyMode>("merge");
  const [plan, setPlan] = useState<TemplatePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ templates: TemplateOption[] }>("/api/workspace/templates").then(({ ok, data }) => {
      if (ok) setTemplates(data.templates);
    });
  }, []);

  async function call(dryRun: boolean) {
    setBusy(true);
    const { ok, data } = await api<{ plan?: TemplatePlan; error?: string }>(
      `/api/workspace/projects/${projectId}/phases`,
      { method: "POST", body: JSON.stringify({ templateKey: key, mode, dryRun }) },
    );
    setBusy(false);
    if (!ok || !data.plan) {
      setError(workspaceError(data.error));
      return;
    }
    setError("");
    if (dryRun) setPlan(data.plan);
    else {
      setPlan(null);
      setKey("");
      onApplied();
    }
  }

  const nothing = plan && !plan.addPhases.length && !plan.addTasks.length && !plan.removePhases.length;

  if (templates === null) {
    return (
      <div className="border-t border-border/80 p-4">
        <LoadingSkeleton rows={2} label="در حال بارگذاری قالب‌ها" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border/80 p-4">
      <h3 className="text-sm font-semibold">اعمال قالب</h3>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <PickerField
          label="قالب"
          value={key}
          onChange={(next) => {
            setKey(next);
            setPlan(null);
          }}
          options={templates.map((t) => ({ id: t.key, label: t.name }))}
        />
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1 text-xs text-muted-foreground">روش اعمال</legend>
          {(["merge", "replace"] as const).map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`template-mode-${projectId}`}
                checked={mode === value}
                onChange={() => {
                  setMode(value);
                  setPlan(null);
                }}
              />
              {MODE_LABELS[value]}
            </label>
          ))}
        </fieldset>
      </div>

      {plan ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3 text-sm" aria-live="polite">
          {nothing ? (
            <p>همهٔ فازها و وظایف این قالب از قبل در پروژه هستند؛ چیزی تغییر نمی‌کند.</p>
          ) : (
            <>
              {plan.addPhases.length ? (
                <p>
                  <span className="font-medium">
                    {toPersianDigits(String(plan.addPhases.length))} فاز اضافه می‌شود:
                  </span>{" "}
                  {plan.addPhases
                    .map((p) => (p.startDate ? `${p.name} (${formatJalali(p.startDate)})` : p.name))
                    .join("، ")}
                </p>
              ) : null}
              {plan.addTasks.length ? (
                <p>
                  <span className="font-medium">
                    {toPersianDigits(String(plan.addTasks.length))} وظیفهٔ آغازین:
                  </span>{" "}
                  {plan.addTasks.join("، ")}
                </p>
              ) : null}
              {plan.removePhases.length ? (
                <p className="text-rose-700 dark:text-rose-300">
                  <span className="font-medium">حذف فازهای خالی:</span>{" "}
                  {plan.removePhases.map((p) => p.name).join("، ")}
                </p>
              ) : null}
              {plan.keptPhases.length ? (
                <p className="text-muted-foreground">بدون تغییر: {plan.keptPhases.join("، ")}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <SecondaryButton onClick={() => void call(true)} disabled={!key || busy}>
          پیش‌نمایش
        </SecondaryButton>
        {plan && !nothing ? (
          <PrimaryButton type="button" onClick={() => void call(false)} disabled={busy}>
            {busy ? "در حال اعمال…" : "اعمال همین تغییرات"}
          </PrimaryButton>
        ) : null}
      </div>
    </div>
  );
}
