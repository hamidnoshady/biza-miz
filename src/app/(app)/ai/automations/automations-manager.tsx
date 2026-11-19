"use client";

/**
 * «اتوماسیون‌ها» — the business's own WHEN / IF / THEN rules (Phase I).
 *
 * The automation engine shipped in Phase D (validation against the live action
 * catalogue, real-fact conditions, the shared guarded firing path) with its UI
 * explicitly deferred to Phase I. This is that UI: list the rules, create one
 * (trigger · optional single condition · action · approval · optional project
 * label), toggle it on/off, run it once on demand, and delete it — every write
 * going through `/api/ai/automations`, which is the same service the assistant
 * proposes through, so a rule made here and a rule the AI proposes are the same
 * object under one guard.
 *
 * The condition editor is deliberately one optional condition (the API accepts
 * up to ten in an all/any document); a single gate covers "when A/R is over X,
 * remind me" — the motivating case — without a query-builder's weight. Richer
 * documents remain expressible through the assistant.
 */

import { useCallback, useEffect, useState } from "react";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  AUTOMATION_FIELD_LABELS,
  automationErrorMessage,
  type AutomationField,
  type AutomationOperator,
} from "@/lib/ai-automations";
import {
  COWORKER_APPROVAL_LABELS,
  COWORKER_EVENT_LABELS,
  COWORKER_TRIGGER_LABELS,
  COWORKER_WEEKDAYS,
  coworkerTriggerSummary,
} from "@/lib/ai-coworker";
import { actionLabel, type ActionType } from "@/lib/ai";
import { api } from "@/app/dashboard/ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { Field, inputClass } from "@/app/dashboard/ui";
import { clearPendingIdempotencyKey, pendingIdempotencyKey } from "@/lib/pending-idempotency";

const OPERATOR_LABELS: Record<AutomationOperator, string> = {
  gte: "بزرگ‌تر یا مساوی",
  lte: "کوچک‌تر یا مساوی",
  eq: "برابر با",
};

interface AutomationView {
  id: string;
  name: string;
  projectId: string | null;
  triggerKind: "manual" | "schedule" | "event";
  eventKind: "shift_open" | "shift_close" | "day_close" | null;
  scheduleHour: number | null;
  scheduleWeekday: number | null;
  conditions: { all?: { field: string; op: string; value: number }[]; any?: { field: string; op: string; value: number }[] };
  actionType: string;
  approvalMode: "ask" | "auto";
  enabled: boolean;
  lastRunAt: string | null;
}

interface Catalogue {
  selectableFields: { field: AutomationField; label: string }[];
  selectableOperators: readonly AutomationOperator[];
  selectableEventKinds: readonly ("shift_open" | "shift_close" | "day_close")[];
  selectableActions: ActionType[];
}

interface ProjectOption {
  id: string;
  name: string;
}

function conditionSummary(a: AutomationView, fieldLabels: Record<string, string>): string | null {
  const first = a.conditions.all?.[0] ?? a.conditions.any?.[0];
  if (!first) return null;
  const field = fieldLabels[first.field] ?? first.field;
  const op = OPERATOR_LABELS[first.op as AutomationOperator] ?? first.op;
  return `اگر ${field} ${op} ${first.value.toLocaleString("fa-IR")}`;
}

/**
 * The idempotency key for one automation's manual run, retained until the
 * outcome is confirmed.
 *
 * A key held only in component state disappears when this manager unmounts —
 * switching to another AI panel section and back, or a page reload — and the
 * next click then generates a new key and runs the automation a second time.
 * It is persisted per tab instead, under the automation's own scope, by the
 * same helper the retail forms use. The run's dedupe key on the server is
 * `manual-request:<actorUserId>:<key>`, so a retained key stays bound to the
 * member and business that caused it.
 */
function runKeyScope(automationId: string): string {
  return `ai.automation.run:${automationId}`;
}

export function AutomationsManager({ canAutoApply }: { canAutoApply: boolean }) {
  const locked = useFeatureLocked();
  const [automations, setAutomations] = useState<AutomationView[]>([]);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ automations: AutomationView[] } & Catalogue>("/api/ai/automations");
    if (ok) {
      setAutomations(data.automations ?? []);
      setCatalogue({
        selectableFields: data.selectableFields ?? [],
        selectableOperators: data.selectableOperators ?? [],
        selectableEventKinds: data.selectableEventKinds ?? [],
        selectableActions: data.selectableActions ?? [],
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    void api<{ projects: ProjectOption[] }>("/api/ai/projects").then(({ ok, data }) => {
      if (ok) setProjects(data.projects ?? []);
    });
  }, [load]);

  const fieldLabels: Record<string, string> = { ...AUTOMATION_FIELD_LABELS };

  async function toggle(a: AutomationView) {
    setBusyId(a.id);
    const { ok, data } = await api<{ error?: string }>(`/api/ai/automations/${a.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: a.name,
        projectId: a.projectId,
        triggerKind: a.triggerKind,
        eventKind: a.eventKind,
        scheduleHour: a.scheduleHour,
        scheduleWeekday: a.scheduleWeekday,
        conditions: a.conditions,
        actionType: a.actionType,
        approvalMode: a.approvalMode,
        enabled: !a.enabled,
      }),
    });
    setBusyId(null);
    if (!ok) {
      toast.error(automationErrorMessage(data.error ?? ""));
      return;
    }
    toast.success(a.enabled ? "غیرفعال شد" : "فعال شد");
    void load();
  }

  async function runNow(a: AutomationView) {
    const key = pendingIdempotencyKey(window.sessionStorage, runKeyScope(a.id), { automationId: a.id });
    setBusyId(a.id);
    const { ok, data } = await api<{ error?: string; run?: { outcome: string } }>(
      `/api/ai/automations/${a.id}/run`,
      { method: "POST", headers: { "Idempotency-Key": key } },
    );
    setBusyId(null);
    if (!ok) {
      // Network and server errors can leave the outcome unknown. Keep the key
      // for the next attempt so a committed action cannot run twice.
      toast.error(automationErrorMessage(data.error ?? ""));
      return;
    }
    const outcome = data.run?.outcome;
    if (outcome === "running") {
      toast.info("در حال اجراست. برای بررسی نتیجه دوباره همین دکمه را بزنید.");
      return;
    }
    switch (outcome) {
      case "applied": toast.success("اجرا شد و ثبت گردید"); break;
      case "pending_approval": toast.info("برای تأیید شما گذاشته شد"); break;
      case "skipped": toast.info("شرط‌ها برقرار نبود؛ کاری انجام نشد"); break;
      case "failed": toast.error("اجرای اتوماسیون ناموفق بود"); break;
      default: toast.info("نتیجهٔ اجرا هنوز تأیید نشده است"); return;
    }
    clearPendingIdempotencyKey(window.sessionStorage, runKeyScope(a.id));
    void load();
  }

  async function remove(a: AutomationView) {
    if (!window.confirm(`«${a.name}» حذف شود؟`)) return;
    setBusyId(a.id);
    const { ok } = await api(`/api/ai/automations/${a.id}`, { method: "DELETE" });
    setBusyId(null);
    if (!ok) {
      toast.error("حذف نشد");
      return;
    }
    toast.success("حذف شد");
    void load();
  }

  if (loading) return <LoadingSkeleton rows={4} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {automations.length > 0
            ? `${automations.length.toLocaleString("fa-IR")} قاعده`
            : "هنوز قاعده‌ای نساخته‌اید."}
        </p>
        <Button type="button" onClick={() => setShowForm((v) => !v)} disabled={locked} className="gap-2">
          <PlusIcon className="size-4" aria-hidden="true" />
          {showForm ? "بستن" : "قاعدهٔ جدید"}
        </Button>
      </div>

      {showForm && catalogue ? (
        <AutomationForm
          catalogue={catalogue}
          projects={projects}
          canAutoApply={canAutoApply}
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
        />
      ) : null}

      {automations.length === 0 ? (
        <EmptyState>
          یک قاعدهٔ «هر وقت… اگر… آنگاه…» بسازید — مثلاً «هر روز صبح، اگر مجموع مطالبات از ۵۰ میلیون گذشت، یک
          سند یادآوری پیشنهاد بده».
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {automations.map((a) => {
            const cond = conditionSummary(a, fieldLabels);
            return (
              <SectionCard key={a.id} title={a.name}>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={a.enabled ? "positive" : "neutral"}>
                      {a.enabled ? "فعال" : "غیرفعال"}
                    </StatusBadge>
                    <StatusBadge tone={a.approvalMode === "auto" ? "active" : "neutral"}>
                      {COWORKER_APPROVAL_LABELS[a.approvalMode]}
                    </StatusBadge>
                    {a.projectId ? (
                      <StatusBadge tone="neutral">
                        {projects.find((p) => p.id === a.projectId)?.name ?? "پروژه"}
                      </StatusBadge>
                    ) : null}
                  </div>
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">هر وقت:</dt>
                      <dd className="font-medium text-foreground">{coworkerTriggerSummary(a)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-muted-foreground">آنگاه:</dt>
                      <dd className="font-medium text-foreground">{actionLabel(a.actionType)}</dd>
                    </div>
                    {cond ? (
                      <div className="flex gap-2 sm:col-span-2">
                        <dt className="text-muted-foreground">شرط:</dt>
                        <dd className="font-medium text-foreground">{cond}</dd>
                      </div>
                    ) : null}
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={!a.enabled || busyId === a.id}
                      onClick={() => runNow(a)}
                    >
                      <PlayIcon className="size-4" aria-hidden="true" />
                      اجرای فوری
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => toggle(a)}
                    >
                      {a.enabled ? "غیرفعال کن" : "فعال کن"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-destructive hover:text-destructive"
                      disabled={busyId === a.id}
                      onClick={() => remove(a)}
                    >
                      <Trash2Icon className="size-4" aria-hidden="true" />
                      حذف
                    </Button>
                  </div>
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AutomationForm({
  catalogue,
  projects,
  canAutoApply,
  onCreated,
}: {
  catalogue: Catalogue;
  projects: ProjectOption[];
  canAutoApply: boolean;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<"manual" | "schedule" | "event">("schedule");
  const [eventKind, setEventKind] = useState<"shift_open" | "shift_close" | "day_close">("day_close");
  const [scheduleHour, setScheduleHour] = useState("9");
  const [scheduleWeekday, setScheduleWeekday] = useState("");
  const [actionType, setActionType] = useState<string>(catalogue.selectableActions[0] ?? "");
  const [approvalMode, setApprovalMode] = useState<"ask" | "auto">("ask");
  const [projectId, setProjectId] = useState("");
  const [useCondition, setUseCondition] = useState(false);
  const [condField, setCondField] = useState<string>(catalogue.selectableFields[0]?.field ?? "");
  const [condOp, setCondOp] = useState<AutomationOperator>(catalogue.selectableOperators[0] ?? "gte");
  const [condValue, setCondValue] = useState("0");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) {
      toast.error("نام قاعده را وارد کنید.");
      return;
    }
    const conditions =
      useCondition && condField
        ? { all: [{ field: condField, op: condOp, value: Number(condValue) || 0 }] }
        : {};
    setSaving(true);
    const { ok, data } = await api<{ error?: string; messages?: string[] }>("/api/ai/automations", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        triggerKind,
        eventKind: triggerKind === "event" ? eventKind : undefined,
        scheduleHour: triggerKind === "schedule" ? Number(scheduleHour) : undefined,
        scheduleWeekday:
          triggerKind === "schedule" && scheduleWeekday !== "" ? Number(scheduleWeekday) : undefined,
        conditions,
        actionType,
        approvalMode,
        projectId: projectId || undefined,
        enabled: true,
      }),
    });
    setSaving(false);
    if (!ok) {
      toast.error(data.messages?.[0] ?? automationErrorMessage(data.error ?? ""));
      return;
    }
    toast.success("قاعده ساخته شد");
    onCreated();
  }

  return (
    <SectionCard title="قاعدهٔ جدید">
      <div className="space-y-1">
        <Field label="نام قاعده">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً: یادآوری مطالبات صبحگاهی"
            maxLength={120}
          />
        </Field>

        <Field label="هر وقت">
          <select
            className={inputClass}
            value={triggerKind}
            onChange={(e) => setTriggerKind(e.target.value as typeof triggerKind)}
          >
            <option value="schedule">{COWORKER_TRIGGER_LABELS.schedule}</option>
            <option value="event">{COWORKER_TRIGGER_LABELS.event}</option>
            <option value="manual">{COWORKER_TRIGGER_LABELS.manual}</option>
          </select>
        </Field>

        {triggerKind === "schedule" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="ساعت (۰ تا ۲۳)">
              <PersianNumberInput
                className={inputClass}
                value={scheduleHour}
                onChange={(e) => setScheduleHour(e.target.value)}
                inputMode="numeric"
              />
            </Field>
            <Field label="روز هفته">
              <select
                className={inputClass}
                value={scheduleWeekday}
                onChange={(e) => setScheduleWeekday(e.target.value)}
              >
                {COWORKER_WEEKDAYS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}

        {triggerKind === "event" ? (
          <Field label="رویداد کاری">
            <select
              className={inputClass}
              value={eventKind}
              onChange={(e) => setEventKind(e.target.value as typeof eventKind)}
            >
              {catalogue.selectableEventKinds.map((k) => (
                <option key={k} value={k}>
                  {COWORKER_EVENT_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label="آنگاه این کار پیشنهاد/انجام شود">
          <select className={inputClass} value={actionType} onChange={(e) => setActionType(e.target.value)}>
            {catalogue.selectableActions.map((t) => (
              <option key={t} value={t}>
                {actionLabel(t)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="شرط (اختیاری)" as="div">
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useCondition} onChange={(e) => setUseCondition(e.target.checked)} />
            فقط وقتی یک شرط برقرار باشد اجرا شود
          </label>
          {useCondition ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <select className={inputClass} value={condField} onChange={(e) => setCondField(e.target.value)}>
                {catalogue.selectableFields.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select
                className={inputClass}
                value={condOp}
                onChange={(e) => setCondOp(e.target.value as AutomationOperator)}
              >
                {catalogue.selectableOperators.map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </option>
                ))}
              </select>
              <PersianNumberInput
                className={inputClass}
                value={condValue}
                onChange={(e) => setCondValue(e.target.value)}
                inputMode="numeric"
              />
            </div>
          ) : null}
        </Field>

        <Field label="ثبت">
          <select
            className={inputClass}
            value={approvalMode}
            onChange={(e) => setApprovalMode(e.target.value as "ask" | "auto")}
          >
            <option value="ask">{COWORKER_APPROVAL_LABELS.ask}</option>
            {canAutoApply ? <option value="auto">{COWORKER_APPROVAL_LABELS.auto}</option> : null}
          </select>
        </Field>

        {projects.length > 0 ? (
          <Field label="پروژه (اختیاری)" hint="این قاعده را به یک پروژه نسبت دهید.">
            <select className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">بدون پروژه</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <div className="pt-2">
          <Button type="button" onClick={submit} disabled={saving} size="lg" className="font-semibold">
            {saving ? "در حال ساخت…" : "ساخت قاعده"}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
