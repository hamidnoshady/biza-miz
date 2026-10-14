"use client";

/**
 * CRM → «اتوماسیون‌ها»: the rules that act on their own.
 *
 * ## What the screen has to make obvious
 *
 * A rule is invisible by nature — it fires while nobody is looking — so this
 * screen refuses to describe one in the vocabulary of a form. Every rule is
 * written out as a sentence («وقتی …، اگر …، آنگاه …») by the same function the
 * library exports (`automationSentence`), and the runs feed below says what each
 * rule actually did, including when it did nothing and why. A reader who has
 * never opened this page should be able to answer "did anything happen to my
 * customers because of a machine" in one screen.
 *
 * ## The boundary, said out loud
 *
 * The only action that leaves the CRM is «اطلاع به رشد و بازاریابی», and the
 * form says what that means: a signal is recorded and Growth decides. No message
 * is composed, no audience is chosen and nothing is sent from here — the note
 * under that option is not decoration, it is the product rule.
 *
 * ## Composed from the design system
 *
 * `SectionCard`, `EmptyState`, `StatusBadge`, `Button`, `Field`, `inputClass`
 * and the localized number input — the same primitives the rest of the CRM's
 * settings screens use, so a select here looks like a select there.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon, WorkflowIcon, ZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, errorMessage, inputClass } from "@/app/dashboard/ui";
import { formatPersianNumber, toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { rialToToman, tomanToRial } from "@/lib/money";
import { CASE_PRIORITY_LABELS, crmAuditEntityLabel } from "@/lib/crm-shared";
import { CRM_SOURCE_LABELS } from "@/lib/crm-sources";
import {
  CRM_AUTOMATION_ACTION_DEFS,
  CRM_AUTOMATION_ACTIONS,
  CRM_AUTOMATION_CONDITION_DEFS,
  CRM_AUTOMATION_NAME_MAX,
  CRM_AUTOMATION_TRIGGER_DEFS,
  CRM_AUTOMATION_TRIGGERS,
  CRM_FOLLOW_UP_OFFSETS,
  CRM_GROWTH_SIGNAL_LABELS,
  CRM_GROWTH_SIGNALS,
  AUTOMATION_PRIORITY_OPTIONS,
  AUTOMATION_SOURCE_OPTIONS,
  automationSentence as sentenceOf,
  conditionsForTrigger,
  type CrmAutomationAction,
  type CrmAutomationConditionValue,
  type CrmAutomationTrigger,
  type CrmGrowthSignal,
} from "@/lib/crm-automation-rules";
import type {
  CrmAutomationOutcome,
  CrmAutomationRule,
  CrmAutomationRun,
  CrmAutomationServiceError,
} from "@/lib/crm-automation-service";
import { CrmAssigneePicker, UNASSIGNED, type CrmAssignee } from "./crm-assignee-picker";

/** `api()` hands back whatever the body held, including the failure code. */
type ApiError = { error?: string };

interface Payload {
  automations: CrmAutomationRule[];
  runs: CrmAutomationRun[];
  counts: { active: number; total: number; appliedLast30: number };
}

interface Draft {
  id: string | null;
  name: string;
  triggerKey: CrmAutomationTrigger;
  /** The value the reader typed, per condition key — absent means "not used". */
  values: Partial<Record<string, string>>;
  actionKey: CrmAutomationAction;
  member: CrmAssignee;
  offsetDays: number;
  signal: CrmGrowthSignal;
}

const OFFSET_LABELS: Record<number, string> = {
  0: "همان روز",
  1: "۱ روز بعد",
  3: "۳ روز بعد",
  7: "۷ روز بعد",
};

/**
 * The API's error codes as sentences.
 *
 * The codes are the contract (`crm-automation-rules.ts`); this is one of their
 * readers. A code with no line here falls through to `errorMessage`'s own
 * translation rather than printing a key at the reader.
 */
const ERROR_LINES: Partial<Record<CrmAutomationServiceError, string>> = {
  automation_name_required: "برای این قاعده یک نام بنویسید.",
  automation_name_too_long: `نام کوتاه‌تر باشد (حداکثر ${toPersianDigits(CRM_AUTOMATION_NAME_MAX)} نویسه).`,
  automation_condition_invalid: "این شرط با رویداد انتخاب‌شده سازگار نیست.",
  automation_condition_duplicate: "هر شرط را یک بار بگذارید.",
  automation_condition_value_invalid: "مقدار شرط کامل یا معتبر نیست.",
  automation_action_invalid: "کنش انتخاب‌شده شناخته‌شده نیست.",
  automation_action_config_invalid: "تنظیمات کنش کامل نیست: مسئول، مهلت یا نشانه را انتخاب کنید.",
  automation_member_invalid: "عضو انتخاب‌شده عضو این کسب‌وکار نیست.",
  automation_member_inactive: "این عضو غیرفعال شده است؛ یک عضو فعال انتخاب کنید.",
  automation_not_found: "این اتوماسیون پیدا نشد؛ صفحه را تازه کنید.",
};

const OUTCOME_PRESENTATION: Record<
  CrmAutomationOutcome,
  { label: string; tone: "positive" | "neutral" | "danger" | "active" }
> = {
  applied: { label: "اجرا شد", tone: "positive" },
  triggered_growth: { label: "به رشد اطلاع داده شد", tone: "active" },
  skipped: { label: "اجرا نشد", tone: "neutral" },
  failed: { label: "خطا", tone: "danger" },
};

/** Why a rule was considered and did nothing — the question the feed exists for. */
const SKIP_REASONS: Record<string, string> = {
  conditions_not_met: "شرط‌ها برقرار نبود",
  already_owned: "همین حالا مسئولِ خودش است",
  member_inactive: "عضو انتخاب‌شده غیرفعال شده",
  member_missing: "عضو انتخاب‌شده پیدا نشد",
  record_missing: "رکورد تا لحظهٔ اجرا حذف شده بود",
  action_unknown: "کنش این قاعده را این نسخه نمی‌شناسد",
};

/** A stored rule as an editable draft — including amounts, back in Toman. */
function draftFrom(rule: CrmAutomationRule | null): Draft {
  if (!rule) {
    return {
      id: null,
      name: "",
      triggerKey: "deal_stage_changed",
      values: {},
      actionKey: "create_follow_up",
      member: UNASSIGNED,
      offsetDays: 1,
      signal: "needs_follow_up",
    };
  }
  const values: Partial<Record<string, string>> = {};
  for (const condition of rule.conditions ?? []) {
    values[condition.key] =
      condition.key === "value_at_least"
        ? String(rialToToman(Number(condition.value ?? 0)))
        : String(condition.value ?? "");
  }
  return {
    id: rule.id,
    name: rule.name,
    triggerKey: rule.triggerKey,
    values,
    actionKey: rule.actionKey,
    member: rule.actionConfig.memberId
      ? { userId: rule.actionConfig.memberId, name: rule.actionMemberName ?? "" }
      : UNASSIGNED,
    offsetDays: rule.actionConfig.offsetDays ?? 1,
    signal: rule.actionConfig.signal ?? "needs_follow_up",
  };
}

/** The condition document a draft describes, in the shape the API validates. */
function conditionsFrom(draft: Draft): CrmAutomationConditionValue[] {
  const out: CrmAutomationConditionValue[] = [];
  for (const key of conditionsForTrigger(draft.triggerKey)) {
    const raw = draft.values[key];
    if (raw === undefined || raw.trim() === "") continue;
    if (key === "value_at_least") {
      // The reader types Toman because that is the unit the product shows;
      // storage is Rial like every other amount, converted here once.
      const toman = Number(toLatinDigits(raw).replace(/[^\d]/g, ""));
      out.push({ key, value: String(Number.isFinite(toman) ? Math.round(tomanToRial(toman)) : 0) });
      continue;
    }
    out.push({ key, value: raw.trim() });
  }
  return out;
}

export function AutomationsSection({ canConfigure }: { canConfigure: boolean }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `null` = closed, `{ id: null }` = a new rule. */
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<Payload & ApiError>("/api/crm/automations");
    if (!ok) {
      // A failed refresh keeps the rules on screen: an empty page would read as
      // "the business has none", which is the opposite of what happened.
      setError(errorMessage(data.error));
      return;
    }
    setError(null);
    setPayload(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!draft || busy) return;
    setBusy(true);
    setNotice(null);
    const { ok, data } = await api<{ automation: CrmAutomationRule } & ApiError>("/api/crm/automations", {
      method: "POST",
      body: JSON.stringify({
        id: draft.id,
        name: draft.name,
        triggerKey: draft.triggerKey,
        conditions: conditionsFrom(draft),
        actionKey: draft.actionKey,
        actionConfig: {
          memberId: draft.member.userId || null,
          offsetDays: draft.actionKey === "create_follow_up" ? draft.offsetDays : null,
          signal: draft.actionKey === "notify_growth" ? draft.signal : null,
        },
      }),
    });
    setBusy(false);
    if (!ok) {
      setNotice(ERROR_LINES[data.error as CrmAutomationServiceError] ?? errorMessage(data.error));
      return;
    }
    setDraft(null);
    await load();
  }, [draft, busy, load]);

  const toggle = useCallback(
    async (rule: CrmAutomationRule) => {
      if (busy) return;
      setBusy(true);
      const { ok, data } = await api<ApiError>(`/api/crm/automations/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      setBusy(false);
      if (!ok) {
        setNotice(errorMessage(data.error));
        return;
      }
      setNotice(
        rule.isActive
          ? `«${rule.name}» خاموش شد؛ تا روشنش نکنید اجرا نمی‌شود.`
          : `«${rule.name}» روشن شد.`,
      );
      await load();
    },
    [busy, load],
  );

  const remove = useCallback(
    async (rule: CrmAutomationRule) => {
      if (busy) return;
      setBusy(true);
      const { ok, data } = await api<ApiError>(`/api/crm/automations/${rule.id}`, {
        method: "DELETE",
      });
      setBusy(false);
      if (!ok) {
        setNotice(errorMessage(data.error));
        return;
      }
      setNotice(`«${rule.name}» حذف شد؛ سابقهٔ اجراهایش می‌ماند.`);
      await load();
    },
    [busy, load],
  );

  const preview = useMemo(
    () =>
      draft
        ? sentenceOf({
            triggerKey: draft.triggerKey,
            conditions: conditionsFrom(draft),
            actionKey: draft.actionKey,
            actionConfig: {
              memberId: draft.member.userId || null,
              offsetDays: draft.actionKey === "create_follow_up" ? draft.offsetDays : null,
              signal: draft.actionKey === "notify_growth" ? draft.signal : null,
            },
          })
        : "",
    [draft],
  );

  if (!payload) {
    return (
      <>
        {error ? (
          <div className="mb-4">
            <ErrorBox>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{error}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  <RefreshCwIcon aria-hidden="true" className="size-4" />
                  تلاش دوباره
                </Button>
              </div>
            </ErrorBox>
          </div>
        ) : null}
        <SectionCardSkeleton />
      </>
    );
  }

  const { automations, runs, counts } = payload;

  return (
    <div className="grid gap-5">
      {error ? (
        <ErrorBox>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              تلاش دوباره
            </Button>
          </div>
        </ErrorBox>
      ) : null}

      <SectionCard
        title="اتوماسیون‌ها"
        description="قاعده‌هایی که خودشان کار می‌سازند، مالک تعیین می‌کنند یا به رشد و بازاریابی خبر می‌دهند. هیچ پیامی از اینجا ارسال نمی‌شود."
        actions={
          canConfigure ? (
            <Button type="button" size="sm" onClick={() => setDraft(draftFrom(null))} disabled={busy}>
              <PlusIcon aria-hidden="true" className="size-4" />
              اتوماسیون تازه
            </Button>
          ) : (
            <StatusBadge tone="neutral">فقط خواندن</StatusBadge>
          )
        }
      >
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            {counts.active > 0
              ? `${toPersianDigits(counts.active)} قاعدهٔ فعال از ${toPersianDigits(counts.total)} قاعده، و ${formatPersianNumber(counts.appliedLast30)} اجرای واقعی در ۳۰ روز گذشته.`
              : "هیچ قاعدهٔ فعالی نیست. تا وقتی قاعده‌ای روشن نباشد، CRM به‌تنهایی کاری نمی‌کند."}
          </p>

          {notice ? <InfoBox>{notice}</InfoBox> : null}

          {draft ? (
            <RuleBuilder
              draft={draft}
              preview={preview}
              busy={busy}
              onChange={setDraft}
              onCancel={() => {
                setDraft(null);
                setNotice(null);
              }}
              onSave={() => void save()}
            />
          ) : null}

          {automations.length === 0 && !draft ? (
            <EmptyState
              title="هنوز قاعده‌ای ساخته نشده"
              icon={WorkflowIcon}
              action={
                canConfigure ? (
                  <Button type="button" size="sm" onClick={() => setDraft(draftFrom(null))}>
                    ساخت نخستین اتوماسیون
                  </Button>
                ) : undefined
              }
            >
              یک مثال: «وقتی فرصت به مرحلهٔ مذاکره می‌رود، اگر ارزشش دست‌کم ۱۰ میلیون تومان است، آنگاه
              ۳ روز بعد کار پیگیری بساز.»
            </EmptyState>
          ) : null}

          <ul className="grid gap-3">
            {automations.map((rule) => (
              <li key={rule.id}>
                <RuleCard
                  rule={rule}
                  canConfigure={canConfigure}
                  busy={busy}
                  onEdit={() => {
                    setNotice(null);
                    setDraft(draftFrom(rule));
                  }}
                  onToggle={() => void toggle(rule)}
                  onDelete={() => void remove(rule)}
                />
              </li>
            ))}
          </ul>
        </div>
      </SectionCard>

      <SectionCard
        title="آخرین اجراها"
        description="اینکه هر قاعده واقعاً چه کرد — و اگر کاری نکرد، چرا. دفتر فقط افزودنی است و پاک نمی‌شود."
      >
        {runs.length === 0 ? (
          <EmptyState>
            هنوز هیچ رویدادی به این قاعده‌ها نخورده است. با نخستین جابه‌جایی معامله، تیکت تازه یا سرنخ
            تازه، همین‌جا نشان داده می‌شود.
          </EmptyState>
        ) : (
          <ul className="grid gap-2">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

/** One rule, as a sentence with its own controls. */
function RuleCard({
  rule,
  canConfigure,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: CrmAutomationRule;
  canConfigure: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border/80 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{rule.name}</h3>
            <StatusBadge tone={rule.isActive ? "positive" : "neutral"} dot>
              {rule.isActive ? "فعال" : "خاموش"}
            </StatusBadge>
            {CRM_AUTOMATION_ACTION_DEFS[rule.actionKey]?.side === "growth" ? (
              <StatusBadge tone="active">خبر به رشد</StatusBadge>
            ) : null}
          </div>
          <p className="mt-2 text-sm leading-6 text-foreground">{sentenceOf(rule)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {rule.runCount > 0 && rule.lastRunAt
              ? `آخرین اجرا: ${toPersianDigits(formatJalali(rule.lastRunAt, { withTime: true }))} • ${formatPersianNumber(rule.runCount)} بار اجرا شده`
              : "تا حالا اجرا نشده"}
          </p>
        </div>
        {canConfigure ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onEdit} disabled={busy}>
              ویرایش
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onToggle} disabled={busy}>
              {rule.isActive ? "خاموش کن" : "روشن کن"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              disabled={busy}
              aria-label={`حذف اتوماسیون ${rule.name}`}
            >
              <Trash2Icon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One line of the runs feed. */
function RunRow({ run }: { run: CrmAutomationRun }) {
  const presentation = OUTCOME_PRESENTATION[run.outcome] ?? OUTCOME_PRESENTATION.skipped;
  const reason =
    typeof run.detail?.reason === "string" ? SKIP_REASONS[run.detail.reason as string] : undefined;
  const error = typeof run.detail?.error === "string" ? (run.detail.error as string) : undefined;
  const signal = typeof run.detail?.signal === "string" ? (run.detail.signal as string) : null;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
        <span className="font-medium text-foreground">{run.automationName}</span>
        <span className="text-muted-foreground">
          روی {crmAuditEntityLabel(run.entityType)}
          {signal && CRM_GROWTH_SIGNAL_LABELS[signal as CrmGrowthSignal]
            ? ` — ${CRM_GROWTH_SIGNAL_LABELS[signal as CrmGrowthSignal]}`
            : ""}
        </span>
        {reason ? <span className="text-muted-foreground">• {reason}</span> : null}
        {error ? <span className="text-destructive">• {error}</span> : null}
      </div>
      <time className="text-xs text-muted-foreground" dateTime={run.at}>
        {toPersianDigits(formatJalali(run.at, { withTime: true }))}
      </time>
    </li>
  );
}

/** The builder: one row per part of the sentence, and the sentence itself. */
function RuleBuilder({
  draft,
  preview,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  preview: string;
  busy: boolean;
  onChange: (next: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const action = CRM_AUTOMATION_ACTION_DEFS[draft.actionKey];
  const conditions = conditionsForTrigger(draft.triggerKey);

  return (
    <div className="grid gap-4 rounded-2xl border border-border/80 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          {draft.id ? "ویرایش اتوماسیون" : "اتوماسیون تازه"}
        </h3>
        <p className="text-xs text-muted-foreground">
          قاعده همیشه از سه بخش ساخته می‌شود: وقتی، اگر، آنگاه.
        </p>
      </div>

      <Field label="نام قاعده" hint="نامی که در همین فهرست می‌بینید؛ مثل «پیگیری مذاکره‌های بزرگ».">
        <input
          className={inputClass}
          value={draft.name}
          maxLength={CRM_AUTOMATION_NAME_MAX}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="پیگیری مذاکره‌های بزرگ"
        />
      </Field>

      <Field label="وقتی" hint={CRM_AUTOMATION_TRIGGER_DEFS[draft.triggerKey].why}>
        <select
          className={inputClass}
          value={draft.triggerKey}
          onChange={(event) =>
            onChange({
              ...draft,
              triggerKey: event.target.value as CrmAutomationTrigger,
              // Conditions are declared per trigger, so switching the trigger
              // clears any condition its records could never satisfy — rather
              // than sending it and being refused, or worse, keeping a value
              // that silently never applies.
              values: {},
            })
          }
        >
          {CRM_AUTOMATION_TRIGGERS.map((trigger) => (
            <option key={trigger} value={trigger}>
              {CRM_AUTOMATION_TRIGGER_DEFS[trigger].label}
            </option>
          ))}
        </select>
      </Field>

      <fieldset className="grid gap-2 rounded-xl border border-border/60 p-3">
        <legend className="px-1 text-xs font-semibold text-muted-foreground">
          اگر — خالی بگذارید تا همیشه اجرا شود
        </legend>
        {conditions.map((key) => {
          const definition = CRM_AUTOMATION_CONDITION_DEFS[key];
          const value = draft.values[key] ?? "";
          const used = draft.values[key] !== undefined;
          const set = (next: string | undefined) => {
            const values = { ...draft.values };
            if (next === undefined || next === "") delete values[key];
            else values[key] = next;
            onChange({ ...draft, values });
          };
          return (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input"
                  checked={used}
                  onChange={(event) => set(event.target.checked ? defaultValueFor(key) : undefined)}
                  aria-label={`بهره‌گیری از شرط ${definition.label}`}
                />
                {definition.label}
              </label>
              {used && definition.valueKind === "amount" ? (
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  allowNegative={false}
                  grouping
                  value={value}
                  onChange={(event) => set(event.target.value)}
                  placeholder="۱۰٬۰۰۰٬۰۰۰"
                  aria-label="کمترین ارزش معامله به تومان"
                />
              ) : null}
              {used && definition.valueKind === "source" ? (
                <select
                  className={inputClass}
                  value={value}
                  onChange={(event) => set(event.target.value)}
                  aria-label="منبع سرنخ"
                >
                  <option value="">یک منبع انتخاب کنید…</option>
                  {AUTOMATION_SOURCE_OPTIONS.map((source) => (
                    <option key={source} value={source}>
                      {CRM_SOURCE_LABELS[source]}
                    </option>
                  ))}
                </select>
              ) : null}
              {used && definition.valueKind === "priority" ? (
                <select
                  className={inputClass}
                  value={value}
                  onChange={(event) => set(event.target.value)}
                  aria-label="اولویت تیکت"
                >
                  <option value="">یک اولویت انتخاب کنید…</option>
                  {AUTOMATION_PRIORITY_OPTIONS.map((priority) => (
                    <option key={priority} value={priority}>
                      {CASE_PRIORITY_LABELS[priority]}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <Field label="آنگاه" hint={action.why}>
        <select
          className={inputClass}
          value={draft.actionKey}
          onChange={(event) => onChange({ ...draft, actionKey: event.target.value as CrmAutomationAction })}
        >
          {CRM_AUTOMATION_ACTIONS.map((key) => (
            <option key={key} value={key}>
              {CRM_AUTOMATION_ACTION_DEFS[key].label}
            </option>
          ))}
        </select>
      </Field>

      {action.needsMember ? (
        <CrmAssigneePicker
          label="کار به عهدهٔ چه کسی باشد؟"
          hint="فقط اعضای فعال کسب‌وکار. اگر این عضو تا زمان اجرا غیرفعال شود، کار به مسئول همان رکورد می‌رسد و اگر آن هم نباشد، در صف «بدون مسئول» می‌ماند."
          value={draft.member}
          onChange={(member) => onChange({ ...draft, member })}
        />
      ) : null}

      {action.needsOffset ? (
        <Field label="چه زمانی یادآوری شود؟" hint="از امروزِ کسب‌وکار شمرده می‌شود، نه از ساعت سرور.">
          <select
            className={inputClass}
            value={String(draft.offsetDays)}
            onChange={(event) => onChange({ ...draft, offsetDays: Number(event.target.value) })}
          >
            {CRM_FOLLOW_UP_OFFSETS.map((offset) => (
              <option key={offset} value={offset}>
                {OFFSET_LABELS[offset] ?? `${toPersianDigits(offset)} روز بعد`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {action.needsSignal ? (
        <Field
          label="چه نشانه‌ای ثبت شود؟"
          hint="هیچ پیامی از اینجا ارسال نمی‌شود: فقط یک نشانه در برنامهٔ رشد ثبت می‌شود و ساخت کمپین، بررسی رضایت و ارسال، کارِ خودِ رشد و بازاریابی است."
        >
          <select
            className={inputClass}
            value={draft.signal}
            onChange={(event) => onChange({ ...draft, signal: event.target.value as CrmGrowthSignal })}
          >
            {CRM_GROWTH_SIGNALS.map((signal) => (
              <option key={signal} value={signal}>
                {CRM_GROWTH_SIGNAL_LABELS[signal]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      <InfoBox>
        <span className="font-medium">قاعده‌ای که ساخته می‌شود: </span>
        {preview}
      </InfoBox>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onSave} disabled={busy}>
          <ZapIcon aria-hidden="true" className="size-4" />
          {busy ? "در حال ذخیره…" : draft.id ? "ذخیرهٔ تغییرات" : "ساخت اتوماسیون"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          انصراف
        </Button>
      </div>
    </div>
  );
}

/** What a condition starts as the moment it is switched on. */
function defaultValueFor(key: keyof typeof CRM_AUTOMATION_CONDITION_DEFS): string {
  const kind = CRM_AUTOMATION_CONDITION_DEFS[key].valueKind;
  if (kind === "amount") return "10000000";
  if (kind === "source") return AUTOMATION_SOURCE_OPTIONS[0] ?? "";
  if (kind === "priority") return AUTOMATION_PRIORITY_OPTIONS[1] ?? AUTOMATION_PRIORITY_OPTIONS[0] ?? "";
  return "";
}
