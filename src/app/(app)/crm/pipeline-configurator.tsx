"use client";

/**
 * CRM settings → «قیف فروش» — the pipeline and stage configurator.
 *
 * ## What it replaces
 *
 * A static six-item list rendered from `DEAL_STAGES`, with a note explaining
 * that the stages were fixed. They were not: `crm_pipelines` and
 * `crm_pipeline_stages` have been rows since migration 0157, and
 * `savePipelineStages` has enforced their rules — in-use deletion protection, at
 * least one open stage, at least one won stage, whole-list ordering — since it
 * was written. Nothing called it. A jeweller with «ارزیابی» and «سفارش ساخت»
 * was told to use «واجد شرایط».
 *
 * ## The rules it shows rather than discovers
 *
 * Every refusal the service can give has a sentence here, and the two that
 * matter are pre-empted with the numbers:
 *
 * - **A stage holding deals cannot be deleted.** The usage counts arrive with
 *   the pipeline, so the editor disables the delete control and says how many
 *   deals are sitting there. A rule a person meets only as a rejected save is a
 *   rule they will look for a way around.
 * - **A pipeline keeps one open and one won stage.** Leaving without either is
 *   refused with a reason rather than a constraint violation: no open stage
 *   means no deal can be created, and no won stage means the win rate is
 *   structurally zero.
 *
 * ## Ordering is a property of the list
 *
 * Stages are reordered with the arrow controls and saved as a whole list, which
 * is what the service takes. There is no per-stage save, so two managers
 * editing at once cannot interleave into a board neither of them chose.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";

interface Stage {
  id: string;
  pipelineId: string;
  name: string;
  legacyKey: string | null;
  displayOrder: number;
  defaultProbability: number;
  outcome: "open" | "won" | "lost";
  isActive: boolean;
  requirementNote: string;
}

interface Pipeline {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  archivedAt: string | null;
  stages: Stage[];
}

interface Usage {
  pipelineId: string;
  stages: { stageId: string; dealCount: number; departedCount: number }[];
}

interface Payload {
  pipelines: Pipeline[];
  usage: Usage[];
  selectedPipelineId: string | null;
}

/** A stage as the editor holds it — before it has been saved, so `id` may be missing. */
interface DraftStage {
  id?: string;
  name: string;
  defaultProbability: number;
  outcome: "open" | "won" | "lost";
  isActive: boolean;
  requirementNote: string;
}

const OUTCOME_LABELS: Record<DraftStage["outcome"], string> = {
  open: "باز",
  won: "برنده",
  lost: "بازنده",
};

const ERROR_MESSAGES: Record<string, string> = {
  stages_required: "قیف باید دست‌کم یک مرحله داشته باشد.",
  open_stage_required: "قیف باید دست‌کم یک مرحلهٔ «باز» داشته باشد، وگرنه هیچ معامله‌ای ساخته نمی‌شود.",
  won_stage_required: "قیف باید دست‌کم یک مرحلهٔ «برنده» داشته باشد، وگرنه نرخ برد همیشه صفر است.",
  duplicate_stage_name: "نام دو مرحله یکسان است. نام هر مرحله باید یکتا باشد.",
  stage_in_use: "مرحله‌ای که معامله دارد حذف نمی‌شود؛ به‌جایش غیرفعالش کنید.",
  name_required: "نام قیف الزامی است.",
  duplicate_name: "قیفی با همین نام وجود دارد.",
  default_pipeline_required: "قیف پیش‌فرض بایگانی نمی‌شود؛ اول قیف دیگری را پیش‌فرض کنید.",
  pipeline_in_use: "این قیف معاملهٔ باز دارد؛ تا تعیین تکلیف آن‌ها بایگانی نمی‌شود.",
  not_found: "این قیف پیدا نشد. صفحه را دوباره بارگذاری کنید.",
  bad_request: "درخواست نامعتبر بود.",
};

function messageFor(error: string | undefined, fallback: string): string {
  return (error && ERROR_MESSAGES[error]) || fallback;
}

export function PipelineConfigurator({ canConfigure }: { canConfigure: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftStage[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback((preferId?: string) => {
    setBusy(true);
    return api<Payload>("/api/crm/pipelines").then(({ ok, data: payload, aborted }) => {
      if (aborted) return;
      if (ok) {
        setData(payload);
        const next = preferId ?? payload.selectedPipelineId ?? payload.pipelines[0]?.id ?? null;
        setSelectedId(next);
        setDraft(null);
        setError("");
      } else {
        setError("بارگذاری قیف فروش ناموفق بود.");
      }
      setLoading(false);
      setBusy(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pipeline = data?.pipelines.find((entry) => entry.id === selectedId) ?? null;
  const usage = new Map(
    (data?.usage.find((entry) => entry.pipelineId === selectedId)?.stages ?? []).map((entry) => [
      entry.stageId,
      entry,
    ]),
  );

  const select = (id: string) => {
    setSelectedId(id);
    setDraft(null);
    setError("");
    setNotice("");
  };

  const startEditing = () => {
    if (!pipeline) return;
    setDraft(
      pipeline.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        defaultProbability: stage.defaultProbability,
        outcome: stage.outcome,
        isActive: stage.isActive,
        requirementNote: stage.requirementNote,
      })),
    );
    setError("");
    setNotice("");
  };

  const patchDraft = (index: number, patch: Partial<DraftStage>) =>
    setDraft((current) =>
      current ? current.map((stage, position) => (position === index ? { ...stage, ...patch } : stage)) : current,
    );

  const move = (index: number, direction: -1 | 1) =>
    setDraft((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const addStage = () =>
    setDraft((current) => [
      ...(current ?? []),
      { name: "مرحلهٔ تازه", defaultProbability: 50, outcome: "open" as const, isActive: true, requirementNote: "" },
    ]);

  const removeStage = (index: number) =>
    setDraft((current) => (current ? current.filter((_, position) => position !== index) : current));

  const saveStages = async () => {
    if (!draft || !pipeline || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data: payload } = await api<{
      pipeline?: Pipeline;
      pipelines?: Pipeline[];
      usage?: Usage;
      error?: string;
    }>(`/api/crm/pipelines/${pipeline.id}/stages`, {
      method: "PUT",
      body: JSON.stringify({
        stages: draft.map((stage, index) => ({ ...stage, displayOrder: index + 1 })),
      }),
    });
    setBusy(false);
    if (ok && payload.pipeline) {
      setNotice("مراحل قیف ذخیره شد.");
      setDraft(null);
      if (payload.pipelines && payload.usage) {
        setData((current) =>
          current
            ? {
                ...current,
                pipelines: payload.pipelines!,
                usage: [
                  ...current.usage.filter((entry) => entry.pipelineId !== payload.usage!.pipelineId),
                  payload.usage!,
                ],
              }
            : current,
        );
      } else {
        void load(pipeline.id);
      }
      return;
    }
    setError(messageFor(payload.error, "ذخیرهٔ مراحل ناموفق بود."));
  };

  const createPipeline = async () => {
    if (busy) return;
    const name = window.prompt("نام قیف تازه (مثلاً «فروش سازمانی»):")?.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    const { ok, data: payload } = await api<{ pipeline?: Pipeline }>("/api/crm/pipelines", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (ok && payload.pipeline) {
      setNotice(`قیف «${payload.pipeline.name}» ساخته شد و مراحل قیف پیش‌فرض در آن کپی شد.`);
      void load(payload.pipeline.id);
      return;
    }
    setError(messageFor((payload as { error?: string }).error, "ساخت قیف ناموفق بود."));
  };

  const patchPipeline = async (body: Record<string, unknown>, success: string) => {
    if (!pipeline || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data: payload } = await api<{ error?: string }>(`/api/crm/pipelines/${pipeline.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (ok) {
      setNotice(success);
      void load(pipeline.id);
      return;
    }
    setError(messageFor(payload.error, "ویرایش قیف ناموفق بود."));
  };

  const renamePipeline = async () => {
    if (!pipeline) return;
    const name = window.prompt("نام قیف:", pipeline.name)?.trim();
    if (!name || name === pipeline.name) return;
    await patchPipeline({ name }, "نام قیف ذخیره شد.");
  };

  if (loading && !data) {
    return <SectionCardSkeleton rows={5} label="در حال بارگذاری قیف فروش" />;
  }

  if (!data) {
    return (
      <SectionCard title="قیف فروش">
        <ErrorBox>{error || "بارگذاری قیف فروش ناموفق بود."}</ErrorBox>
        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" onClick={() => load()} disabled={busy}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            تلاش دوباره
          </Button>
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-3">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="قیف">
          <select
            className={inputClass}
            value={selectedId ?? ""}
            onChange={(event) => select(event.target.value)}
            aria-label="انتخاب قیف فروش"
          >
            {data.pipelines.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
                {entry.isDefault ? " (پیش‌فرض)" : ""}
                {entry.archivedAt ? " — بایگانی‌شده" : ""}
              </option>
            ))}
          </select>
        </Field>
        {canConfigure ? (
          <Button type="button" variant="outline" size="sm" onClick={createPipeline} disabled={busy}>
            <PlusIcon aria-hidden="true" className="size-4" />
            قیف تازه
          </Button>
        ) : null}
      </div>

      {pipeline ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={pipeline.isDefault ? "positive" : "neutral"}>
              {pipeline.isDefault ? "قیف پیش‌فرض" : "قیف"}
            </StatusBadge>
            {pipeline.description ? (
              <span className="text-xs text-muted-foreground">{pipeline.description}</span>
            ) : null}
            {pipeline.archivedAt ? <StatusBadge tone="danger">بایگانی‌شده</StatusBadge> : null}
          </div>

          {!canConfigure ? (
            <InfoBox>
              نمایش مراحل؛ برای تغییر، دسترسی «تنظیمات ارتباط با مشتری» لازم است.
            </InfoBox>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={renamePipeline} disabled={busy}>
                تغییر نام
              </Button>
              {!pipeline.isDefault ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => patchPipeline({ isDefault: true }, "این قیف پیش‌فرض شد.")}
                  disabled={busy}
                >
                  پیش‌فرض کن
                </Button>
              ) : null}
              {!pipeline.isDefault && !pipeline.archivedAt ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => patchPipeline({ archived: true }, "قیف بایگانی شد.")}
                  disabled={busy}
                >
                  بایگانی
                </Button>
              ) : null}
            </div>
          )}

          {draft ? (
            <DraftEditor
              draft={draft}
              busy={busy}
              onPatch={patchDraft}
              onMove={move}
              onRemove={removeStage}
              onAdd={addStage}
              onCancel={() => setDraft(null)}
              onSave={saveStages}
            />
          ) : (
            <StageList
              stages={pipeline.stages}
              usage={usage}
              canConfigure={canConfigure}
              busy={busy}
              onEdit={startEditing}
            />
          )}
        </>
      ) : (
        <EmptyState>هنوز قیفی ساخته نشده است؛ یکی بسازید تا معامله‌ها روی آن بنشینند.</EmptyState>
      )}
    </div>
  );
}

function StageList({
  stages,
  usage,
  canConfigure,
  busy,
  onEdit,
}: {
  stages: Stage[];
  usage: Map<string, { dealCount: number; departedCount: number }>;
  canConfigure: boolean;
  busy: boolean;
  onEdit: () => void;
}) {
  if (stages.length === 0) {
    return (
      <EmptyState>
        این قیف مرحله‌ای ندارد؛ تا وقتی مرحله نسازید معامله‌ای روی آن نمی‌نشیند.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {stages.map((stage, index) => {
          const counts = usage.get(stage.id);
          return (
            <li
              key={stage.id}
              className="min-w-0 rounded-2xl border border-border/80 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{stage.name}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      احتمال پیش‌فرض: {formatPersianNumber(stage.defaultProbability)}٪
                    </p>
                    {stage.requirementNote ? (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{stage.requirementNote}</p>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge
                    tone={stage.outcome === "won" ? "positive" : stage.outcome === "lost" ? "danger" : "neutral"}
                  >
                    {OUTCOME_LABELS[stage.outcome]}
                  </StatusBadge>
                  {!stage.isActive ? <StatusBadge tone="neutral">غیرفعال</StatusBadge> : null}
                </div>
              </div>
              {counts && (counts.dealCount > 0 || counts.departedCount > 0) ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {counts.dealCount > 0
                    ? `${formatPersianNumber(counts.dealCount)} معامله همین حالا در این مرحله است.`
                    : `${formatPersianNumber(counts.departedCount)} معامله از این مرحله گذشته است.`}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {canConfigure ? (
        <Button type="button" variant="outline" size="sm" onClick={onEdit} disabled={busy}>
          ویرایش مراحل
        </Button>
      ) : null}
    </div>
  );
}

function DraftEditor({
  draft,
  busy,
  onPatch,
  onMove,
  onRemove,
  onAdd,
  onCancel,
  onSave,
}: {
  draft: DraftStage[];
  busy: boolean;
  onPatch: (index: number, patch: Partial<DraftStage>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-border/80 p-3">
      <p className="text-sm font-semibold text-foreground">مراحل، به ترتیب قیف</p>
      <ul className="space-y-3">
        {draft.map((stage, index) => (
          <li key={stage.id ?? `new-${index}`} className="grid gap-2 border-b border-border/60 pb-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="نام مرحله">
              <input
                className={inputClass}
                value={stage.name}
                onChange={(event) => onPatch(index, { name: event.target.value })}
                aria-label={`نام مرحلهٔ ${index + 1}`}
              />
            </Field>
            <Field label="احتمال پیش‌فرض (٪)">
              <input
                className={inputClass}
                inputMode="numeric"
                value={String(stage.defaultProbability)}
                onChange={(event) =>
                  onPatch(index, {
                    defaultProbability: Math.min(
                      100,
                      Math.max(0, Number(event.target.value.replace(/[^0-9]/g, "")) || 0),
                    ),
                  })
                }
                aria-label={`احتمال مرحلهٔ ${index + 1}`}
              />
            </Field>
            <Field label="معنی مرحله">
              <select
                className={inputClass}
                value={stage.outcome}
                onChange={(event) => onPatch(index, { outcome: event.target.value as DraftStage["outcome"] })}
                aria-label={`معنی مرحلهٔ ${index + 1}`}
              >
                <option value="open">باز — معامله در جریان است</option>
                <option value="won">برنده — فروش قطعی شد</option>
                <option value="lost">بازنده — از دست رفت</option>
              </select>
            </Field>
            <Field label="وضعیت">
              <div className="flex items-center gap-2">
                <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={stage.isActive}
                    onChange={(event) => onPatch(index, { isActive: event.target.checked })}
                  />
                  فعال
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onMove(index, -1)}
                  disabled={index === 0}
                  aria-label="بالا بردن مرحله"
                >
                  <ArrowUpIcon aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onMove(index, 1)}
                  disabled={index === draft.length - 1}
                  aria-label="پایین بردن مرحله"
                >
                  <ArrowDownIcon aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRemove(index)}
                  aria-label={`حذف مرحلهٔ ${stage.name}`}
                >
                  <TrashIcon aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </Field>
            <Field label="یادداشت مسئولیت مرحله" hint="اختیاری — چه چیزی باید در این مرحله انجام شده باشد.">
              <input
                className={inputClass}
                value={stage.requirementNote}
                onChange={(event) => onPatch(index, { requirementNote: event.target.value })}
                aria-label={`یادداشت مرحلهٔ ${index + 1}`}
              />
            </Field>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <PlusIcon aria-hidden="true" className="size-4" />
          افزودن مرحله
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={busy}>
          {busy ? "در حال ذخیره…" : "ذخیرهٔ مراحل"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        مرحله‌ای که معامله دارد حذف نمی‌شود؛ ذخیره با پیام خطا متوقف می‌شود و می‌توانید غیرفعالش کنید. قیف
        باید دست‌کم یک مرحلهٔ «باز» و یک مرحلهٔ «برنده» داشته باشد.
      </p>
    </div>
  );
}
