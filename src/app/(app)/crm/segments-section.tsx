"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Segment builder and list (Phase 36).
 *
 * The builder writes a **rule document**, never SQL. Every field comes from the
 * closed `SEGMENT_FIELDS` union and every value is bound as a parameter by
 * `compileSegment`, so a segment is user-authored logic that cannot become a
 * user-authored query. That property is enforced in `src/lib/segments.ts` and
 * tested there; this screen's job is to make the document easy to write.
 *
 * The preview is the other half. It shows two numbers — how many customers
 * match, and how many of those can actually be contacted for the chosen
 * purpose — because the gap between them is the fact that decides whether a
 * campaign is worth running. A builder that showed only the consented count
 * would look like it was losing people for no reason.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMoney } from "@/components/money/money-context";
import {
  formatPersianNumber,
  toLatinDigits,
  toPersianDigits,
} from "@/lib/digits";
import {
  describeSegment,
  isSegmentField,
  SEGMENT_FIELDS,
  SEGMENT_OPERATOR_LABELS,
  segmentFieldMeta,
  validateSegmentDefinition,
  type SegmentDefinition,
  type SegmentField,
  type SegmentPurpose,
  type SegmentRule,
} from "@/lib/segments";
import {
  EmptyState,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  inputClass,
  InfoBox,
} from "@/app/dashboard/ui";
import { CrmCardHeading } from "./crm-card-heading";
import { AudienceRequestBox } from "./audience-request-box";

interface Segment {
  id: string;
  name: string;
  description: string;
  definition: SegmentDefinition;
  isBuiltin: boolean;
  memberCount: number;
}

interface Preview {
  count: number;
  totalBeforeConsent: number;
  purpose: SegmentPurpose;
  sample: {
    id: string;
    name: string;
    phone: string | null;
    phoneE164?: string | null;
    email: string | null;
  }[];
}

interface SegmentApiError {
  error?: string;
  problems?: string[];
}

const PURPOSE_LABELS: Record<SegmentPurpose, string> = {
  view: "فقط مشاهده",
  sms: "ارسال پیامک",
  email: "ارسال ایمیل",
};

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);

type RuleGroupKey = "all" | "any";

/** A blank rule for a field, with the shape that field's `valueKind` requires. */
function blankRule(field: SegmentField): SegmentRule {
  const meta = segmentFieldMeta(field);
  const op = meta.operators[0];
  switch (meta.valueKind) {
    case "days":
      return { field, op, days: 30 } as SegmentRule;
    case "tags":
      return { field, op, values: [] } as SegmentRule;
    case "month":
      return { field, op: "is", month: 1 } as SegmentRule;
    case "boolean":
      return { field, op: "is", value: true } as SegmentRule;
    case "text":
      return { field, op: "contains", value: "" } as SegmentRule;
    default:
      return { field, op, value: 0 } as SegmentRule;
  }
}

function definitionFromGroups(
  allRules: SegmentRule[],
  anyRules: SegmentRule[],
): SegmentDefinition {
  const definition: SegmentDefinition = {};
  if (allRules.length > 0) definition.all = allRules;
  if (anyRules.length > 0) definition.any = anyRules;
  return definition;
}

function normalizeRuleForBuilder(rule: unknown): SegmentRule {
  if (
    !rule ||
    typeof rule !== "object" ||
    !isSegmentField((rule as { field?: unknown }).field)
  ) {
    return blankRule("lastPurchaseAt");
  }

  const field = (rule as { field: SegmentField }).field;
  const meta = segmentFieldMeta(field);
  const candidate = rule as Record<string, unknown>;
  const op =
    typeof candidate.op === "string" && meta.operators.includes(candidate.op)
      ? candidate.op
      : meta.operators[0];

  switch (meta.valueKind) {
    case "days": {
      const days =
        typeof candidate.days === "number" &&
        Number.isFinite(candidate.days) &&
        candidate.days >= 0
          ? candidate.days
          : 30;
      return { field, op, days: Math.floor(days) } as SegmentRule;
    }
    case "tags": {
      const values = Array.isArray(candidate.values)
        ? candidate.values
            .filter(
              (value): value is string =>
                typeof value === "string" && value.trim() !== "",
            )
            .map((value) => value.trim())
        : [];
      return { field, op, values } as SegmentRule;
    }
    case "month": {
      const month =
        typeof candidate.month === "number" &&
        Number.isInteger(candidate.month) &&
        candidate.month >= 1 &&
        candidate.month <= 12
          ? candidate.month
          : 1;
      return { field, op: "is", month } as SegmentRule;
    }
    case "boolean":
      return {
        field,
        op: "is",
        value: typeof candidate.value === "boolean" ? candidate.value : true,
      } as SegmentRule;
    case "text":
      return {
        field,
        op: "contains",
        value: typeof candidate.value === "string" ? candidate.value : "",
      } as SegmentRule;
    default: {
      const value =
        typeof candidate.value === "number" && Number.isFinite(candidate.value)
          ? candidate.value
          : 0;
      return { field, op, value } as SegmentRule;
    }
  }
}

function rulesForBuilder(
  definition: SegmentDefinition | null | undefined,
  group: RuleGroupKey,
): SegmentRule[] {
  const rules = definition?.[group];
  return Array.isArray(rules) ? rules.map(normalizeRuleForBuilder) : [];
}

/** The body both error presentations share: the message plus its problem list. */
function ErrorProblems({
  message,
  problems,
}: {
  message: string;
  problems: string[];
}) {
  return (
    <>
      <p>{message}</p>
      {problems.length > 0 ? (
        <ul className="mt-1 list-disc space-y-1 pe-5 text-xs leading-6">
          {problems.map((problem, index) => (
            <li key={`${problem}-${index}`}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A save/validation error, at the top of the dialog. */
function SegmentError({
  message,
  problems,
}: {
  message: string;
  problems: string[];
}) {
  if (!message) return null;
  return (
    <ErrorBox>
      <ErrorProblems message={message} problems={problems} />
    </ErrorBox>
  );
}

export function SegmentsSection() {
  const money = useMoney();
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [editing, setEditing] = useState<Segment | "new" | null>(null);
  // Rules read from a sentence, waiting for the builder to open with them. The
  // box seeds the form and nothing else — the form is still the only writer.
  const [seed, setSeed] = useState<SegmentDefinition | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const { ok, data } = await api<{ segments?: Segment[]; error?: string }>(
      "/api/crm/segments",
    );
    if (ok) {
      setSegments(data.segments ?? []);
    } else {
      setSegments((current) => current ?? []);
      setError(
        data.error ? errorMessage(data.error) : "بارگذاری بخش‌ها ناموفق بود.",
      );
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const archive = async (segment: Segment) => {
    if (!window.confirm(`«${segment.name}» بایگانی شود؟`)) return;
    setError("");
    setInfo("");
    const { ok, data } = await api<SegmentApiError>(
      `/api/crm/segments/${segment.id}`,
      {
        method: "DELETE",
      },
    );
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(
      "بخش بایگانی شد. سابقهٔ آن برای پاسخ‌گویی دربارهٔ ارسال‌های گذشته نگه داشته می‌شود.",
    );
    setSegments(
      (current) => current?.filter((item) => item.id !== segment.id) ?? current,
    );
    void load();
  };

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <CrmCardHeading kicker="رفتار خرید" title="بخش‌بندی مشتریان" />
        }
        description="گروه‌های پویا بر پایهٔ رفتار خرید، برچسب، رضایت ارتباط و ماندهٔ حساب. هر بار که باز می‌شوند، دوباره محاسبه می‌شوند."
        actions={
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void load()}
              disabled={loading}
              aria-label="بازخوانی"
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" className="size-4" />
              بخش جدید
            </Button>
          </div>
        }
      >
        {!segments ? (
          <LoadingSkeleton rows={3} />
        ) : segments.length === 0 ? (
          <EmptyState>
            هنوز بخشی تعریف نشده است. مثلاً «مشتریانی که بیش از ۹۰ روز خرید
            نکرده‌اند و مجموع خریدشان بالای دو میلیون تومان بوده».
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {segments.map((segment) => (
              <li
                key={segment.id}
                className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(segment)}
                      className="min-w-0 max-w-full truncate text-start font-medium text-foreground hover:underline"
                    >
                      {segment.name}
                    </button>
                    {segment.isBuiltin ? (
                      <StatusBadge tone="neutral">پیش‌فرض</StatusBadge>
                    ) : null}
                    <StatusBadge tone="active">
                      {formatPersianNumber(segment.memberCount)} مشتری
                    </StatusBadge>
                  </div>
                  {segment.description ? (
                    <p className="mt-1 text-xs leading-6 text-foreground/80">
                      {segment.description}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs leading-6 text-muted-foreground">
                    {describeSegment(segment.definition, (rial) =>
                      money.format(rial),
                    )}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => archive(segment)}
                  className="w-full justify-center text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto"
                >
                  <Trash2Icon aria-hidden="true" className="size-3.5" />
                  بایگانی
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <AudienceRequestBox
        onSeed={(definition) => {
          setSeed(definition);
          setEditing("new");
        }}
      />

      {editing ? (
        <SegmentDialog
          segment={editing === "new" ? null : editing}
          seed={editing === "new" ? seed : null}
          onClose={() => {
            setSeed(null);
            setEditing(null);
          }}
          onSaved={() => {
            setSeed(null);
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function SegmentDialog({
  segment,
  seed,
  onClose,
  onSaved,
}: {
  segment: Segment | null;
  /** Rules read from a sentence, used only when there is no existing segment. */
  seed: SegmentDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const money = useMoney();
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [allRules, setAllRules] = useState<SegmentRule[]>(() =>
    rulesForBuilder(seed ?? segment?.definition, "all"),
  );
  const [anyRules, setAnyRules] = useState<SegmentRule[]>(() =>
    rulesForBuilder(seed ?? segment?.definition, "any"),
  );
  const [purpose, setPurpose] = useState<SegmentPurpose>("view");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [previewProblems, setPreviewProblems] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [errorProblems, setErrorProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const definition = useMemo(
    () => definitionFromGroups(allRules, anyRules),
    [allRules, anyRules],
  );
  const ruleCount = allRules.length + anyRules.length;

  // Preview on every edit, debounced. The count is the whole point of the
  // builder: a rule you cannot see the effect of is a rule you write blind.
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError("");
    setPreviewProblems([]);
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void api<{ preview?: Preview } & SegmentApiError>(
        "/api/crm/segments/preview",
        {
          method: "POST",
          body: JSON.stringify({ definition, purpose }),
        },
      )
        .then(({ ok, data }) => {
          if (cancelled) return;
          if (ok && data.preview) {
            setPreview(data.preview);
          } else {
            setPreviewError(errorMessage(data.error));
            setPreviewProblems(data.problems ?? []);
          }
        })
        .catch(() => {
          if (!cancelled) setPreviewError(errorMessage("network_error"));
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [definition, purpose]);

  const save = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError(errorMessage("segment_name_required"));
      setErrorProblems([]);
      return;
    }
    const problems = validateSegmentDefinition(definition);
    if (problems.length > 0) {
      setError(errorMessage("segment_definition_invalid"));
      setErrorProblems(problems);
      return;
    }

    setBusy(true);
    setError("");
    setErrorProblems([]);
    const body = JSON.stringify({
      name: name.trim(),
      description: description.trim(),
      definition,
    });
    const { ok, data } = await api<SegmentApiError>(
      segment ? `/api/crm/segments/${segment.id}` : "/api/crm/segments",
      {
        method: segment ? "PATCH" : "POST",
        body,
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      setErrorProblems(data.problems ?? []);
      return;
    }
    onSaved();
  };

  const updateRule = (
    group: RuleGroupKey,
    index: number,
    next: SegmentRule,
  ) => {
    const setter = group === "all" ? setAllRules : setAnyRules;
    setter((current) => current.map((rule, i) => (i === index ? next : rule)));
  };

  const removeRule = (group: RuleGroupKey, index: number) => {
    const setter = group === "all" ? setAllRules : setAnyRules;
    setter((current) => current.filter((_, i) => i !== index));
  };

  const addRule = (group: RuleGroupKey) => {
    const setter = group === "all" ? setAllRules : setAnyRules;
    setter((current) => [...current, blankRule("lastPurchaseAt")]);
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-3xl">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {segment ? `ویرایش ${segment.name}` : "بخش جدید"}
            </DialogTitle>
            <DialogDescription>
              شرط‌های «همه» با AND و شرط‌های «حداقل یکی» با OR محاسبه می‌شوند؛
              اگر هر دو گروه پر باشند، نتیجهٔ نهایی «همهٔ شرط‌های گروه اول» و
              «یکی از شرط‌های گروه دوم» است.
            </DialogDescription>
          </DialogHeader>
          <SegmentError message={error} problems={errorProblems} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="نام بخش">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </Field>
            <Field label="توضیح (اختیاری)">
              <textarea
                className={`${inputClass} h-auto min-h-10 resize-y py-2`}
                rows={1}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </div>

          <div className="space-y-3">
            <RuleGroup
              title="همهٔ این شرط‌ها برقرار باشد"
              description="هر قاعده‌ای که اینجا اضافه می‌شود باید برای مشتری درست باشد."
              emptyText="اگر این گروه خالی باشد، شرط اجباری ندارید."
              rules={allRules}
              onAdd={() => addRule("all")}
              onChange={(index, next) => updateRule("all", index, next)}
              onRemove={(index) => removeRule("all", index)}
            />
            <RuleGroup
              title="حداقل یکی از این شرط‌ها برقرار باشد"
              description="برای ساختن حالت «یا» از این گروه استفاده کنید؛ مثلاً تهران باشد یا ایمیل داشته باشد."
              emptyText="اگر این گروه خالی باشد، بخش فقط از گروه «همه» ساخته می‌شود."
              rules={anyRules}
              onAdd={() => addRule("any")}
              onChange={(index, next) => updateRule("any", index, next)}
              onRemove={(index) => removeRule("any", index)}
            />
          </div>

          <Field
            label="هدف پیش‌نمایش"
            hint="این انتخاب در خود بخش ذخیره نمی‌شود؛ هنگام ارسال کمپین، رضایت پیامک یا ایمیل دوباره در SQL اعمال می‌شود."
          >
            <select
              className={inputClass}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as SegmentPurpose)}
            >
              {(Object.keys(PURPOSE_LABELS) as SegmentPurpose[]).map((key) => (
                <option key={key} value={key}>
                  {PURPOSE_LABELS[key]}
                </option>
              ))}
            </select>
          </Field>

          <div className="rounded-2xl border border-border/80 bg-muted/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">برآورد</p>
              <StatusBadge tone="neutral">
                {formatPersianNumber(ruleCount)} قاعده
              </StatusBadge>
            </div>
            {ruleCount === 0 ? (
              <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                بدون قاعده، این بخش همهٔ مشتریان را شامل می‌شود. برای ارسال
                انبوه، هدف پیامک/ایمیل فقط افراد دارای رضایت و راه ارتباطی را
                نگه می‌دارد.
              </p>
            ) : null}
            {previewLoading ? (
              <LoadingSkeleton
                rows={2}
                compact
                className="mt-2"
                label="در حال محاسبه برآورد بخش"
              />
            ) : previewError ? (
              <div className="mt-2 space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs leading-6 text-destructive">
                <ErrorProblems message={previewError} problems={previewProblems} />
              </div>
            ) : !preview ? (
              <p className="mt-1 text-xs text-muted-foreground">
                برآورد این بخش در دسترس نیست.
              </p>
            ) : (
              <>
                <p className="mt-2 text-sm leading-7 text-foreground/80">
                  {purpose === "view" ? (
                    <>
                      {formatPersianNumber(preview.count)} مشتری در این بخش قرار
                      می‌گیرند.
                    </>
                  ) : (
                    <>
                      {formatPersianNumber(preview.totalBeforeConsent)} مشتری با
                      این قاعده‌ها هم‌خوانی دارند؛ از این میان{" "}
                      <span className="font-semibold text-teal-700 dark:text-teal-300">
                        {formatPersianNumber(preview.count)} نفر
                      </span>{" "}
                      اجازهٔ {PURPOSE_LABELS[purpose]} داده‌اند و راه ارتباطی
                      معتبر دارند.
                    </>
                  )}
                </p>
                <p className="mt-1 text-xs leading-6 text-muted-foreground">
                  {describeSegment(definition, (rial) => money.format(rial))}
                </p>
                {preview.sample.length > 0 ? (
                  <ul
                    className="mt-2 flex flex-wrap gap-1.5"
                    aria-label="نمونه اعضای بخش"
                  >
                    {preview.sample.slice(0, 8).map((member) => (
                      <li key={member.id}>
                        <StatusBadge tone="neutral">{member.name}</StatusBadge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    نمونه‌ای با این شرط‌ها پیدا نشد.
                  </p>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              انصراف
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "در حال ذخیره…" : "ذخیره"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RuleGroup({
  title,
  description,
  emptyText,
  rules,
  onAdd,
  onChange,
  onRemove,
}: {
  title: string;
  description: string;
  emptyText: string;
  rules: SegmentRule[];
  onAdd: () => void;
  onChange: (index: number, next: SegmentRule) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <section
      className="rounded-2xl border border-border/80 bg-background/60 p-3"
      aria-label={title}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="w-full sm:w-auto"
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          افزودن قاعده
        </Button>
      </div>
      {rules.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{emptyText}</p>
      ) : null}
      <div className="mt-3 space-y-2">
        {rules.map((rule, index) => (
          <RuleRow
            key={`${rule.field}-${index}`}
            rule={rule}
            onChange={(next) => onChange(index, next)}
            onRemove={() => onRemove(index)}
          />
        ))}
      </div>
    </section>
  );
}

/** One rule: field, operator, and whatever value shape that field needs. */
function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: SegmentRule;
  onChange: (next: SegmentRule) => void;
  onRemove: () => void;
}) {
  const meta = segmentFieldMeta(rule.field);
  const money = useMoney();

  return (
    <div className="rounded-xl border border-border/80 bg-card/70 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(9rem,1.15fr)_minmax(8rem,0.9fr)_minmax(10rem,1fr)_auto] sm:items-center">
        <select
          className={inputClass}
          value={rule.field}
          onChange={(e) => onChange(blankRule(e.target.value as SegmentField))}
          aria-label="فیلد قاعده"
        >
          {SEGMENT_FIELDS.map((field) => (
            <option key={field.field} value={field.field}>
              {field.label}
            </option>
          ))}
        </select>

        <select
          className={inputClass}
          value={rule.op}
          onChange={(e) =>
            onChange({ ...rule, op: e.target.value } as SegmentRule)
          }
          aria-label="عملگر قاعده"
        >
          {meta.operators.map((op) => (
            <option key={op} value={op}>
              {SEGMENT_OPERATOR_LABELS[op] ?? op}
            </option>
          ))}
        </select>

        <RuleValue rule={rule} meta={meta} onChange={onChange} money={money} />

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label="حذف قاعده"
          className="w-full justify-center text-destructive hover:bg-destructive/10 hover:text-destructive sm:size-10 sm:px-0"
        >
          <Trash2Icon aria-hidden="true" className="size-4" />
          <span className="sm:sr-only">حذف</span>
        </Button>
      </div>
      {meta.hint ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {meta.hint}
        </p>
      ) : null}
    </div>
  );
}

function RuleValue({
  rule,
  meta,
  onChange,
  money,
}: {
  rule: SegmentRule;
  meta: ReturnType<typeof segmentFieldMeta>;
  onChange: (next: SegmentRule) => void;
  money: ReturnType<typeof useMoney>;
}) {
  // Persian digits are accepted everywhere a number is typed: the keyboard the
  // user has is the one they will use.
  const asNumber = (raw: string) =>
    Number(toLatinDigits(raw).replace(/[^\d-]/g, "")) || 0;

  switch (meta.valueKind) {
    case "days":
      return (
        <label className="flex w-full items-center gap-1.5 text-sm text-muted-foreground">
          <input
            className={`${inputClass} flex-1`}
            inputMode="numeric"
            value={toPersianDigits(String((rule as { days: number }).days))}
            onChange={(e) =>
              onChange({
                ...rule,
                days: asNumber(e.target.value),
              } as SegmentRule)
            }
            aria-label="تعداد روز"
          />
          روز
        </label>
      );
    case "money":
      // Rules store integer Rial; the owner types in the business's own unit.
      // Converting here — the one place the two meet — is why a «۲٬۰۰۰٬۰۰۰
      // تومان» rule does not quietly become two million *Rial*.
      return (
        <label className="flex w-full items-center gap-1.5 text-sm text-muted-foreground">
          <input
            className={`${inputClass} flex-1`}
            inputMode="numeric"
            value={toPersianDigits(
              String(money.toInput((rule as { value: number }).value)),
            )}
            onChange={(e) =>
              onChange({
                ...rule,
                value: money.fromInput(asNumber(e.target.value)),
              } as SegmentRule)
            }
            aria-label="مبلغ"
          />
          {money.unitLabel}
        </label>
      );
    case "number":
      return (
        <input
          className={inputClass}
          inputMode="numeric"
          value={toPersianDigits(String((rule as { value: number }).value))}
          onChange={(e) =>
            onChange({
              ...rule,
              value: asNumber(e.target.value),
            } as SegmentRule)
          }
          aria-label="مقدار"
        />
      );
    case "month":
      return (
        <select
          className={inputClass}
          value={String((rule as { month: number }).month)}
          onChange={(e) =>
            onChange({ ...rule, month: Number(e.target.value) } as SegmentRule)
          }
          aria-label="ماه تولد"
        >
          {MONTH_OPTIONS.map((month) => (
            <option key={month} value={month}>
              {toPersianDigits(String(month))}
            </option>
          ))}
        </select>
      );
    case "boolean":
      return (
        <select
          className={inputClass}
          value={(rule as { value: boolean }).value ? "1" : "0"}
          onChange={(e) =>
            onChange({ ...rule, value: e.target.value === "1" } as SegmentRule)
          }
          aria-label="بله یا خیر"
        >
          <option value="1">بله</option>
          <option value="0">خیر</option>
        </select>
      );
    case "tags":
      return (
        <input
          className={inputClass}
          placeholder="برچسب‌ها با ویرگول"
          value={(rule as { values: string[] }).values.join("، ")}
          onChange={(e) =>
            onChange({
              ...rule,
              values: e.target.value
                .split(/[،,]/)
                .map((tag) => tag.trim())
                .filter(Boolean),
            } as SegmentRule)
          }
          aria-label="برچسب‌ها"
        />
      );
    default:
      return (
        <input
          className={inputClass}
          value={String((rule as { value: string }).value ?? "")}
          onChange={(e) =>
            onChange({ ...rule, value: e.target.value } as SegmentRule)
          }
          aria-label="متن"
        />
      );
  }
}
