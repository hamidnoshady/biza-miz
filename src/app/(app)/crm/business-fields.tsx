"use client";

/**
 * CRM settings → «فیلدهای کسب‌وکار» — the typed custom-field definitions.
 *
 * ## What this is
 *
 * Every business has one question about a customer that the schema did not
 * anticipate: «شمارهٔ قرارداد», «طبقه», «منطقه». `crm_custom_fields` defines
 * them and `crm_custom_field_values` stores the answers in typed shadow columns
 * chosen at write time. This screen is the definitions half.
 *
 * ## The two rules it must not undermine
 *
 * - **A field's type cannot change once it holds values.** Reinterpreting a
 *   text answer of «حدود ۵۰۰ هزار» as money either discards what somebody wrote
 *   or invents a figure they never entered. The service refuses it with
 *   `type_change_blocked`, and the type control is disabled here for any field
 *   that is being edited rather than created — the honest way to change a type
 *   is to archive the field and make a new one, which the screen says.
 * - **Archive, never delete.** An answer to a since-archived question is still
 *   a fact somebody entered, so `DELETE` archives and the answer survives.
 *
 * Both of those live in `crm-custom-fields-service.ts`. This component only
 * composes the form around them.
 */

import { useCallback, useEffect, useState } from "react";
import { ArchiveIcon, PencilIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";

const TARGETS = ["party", "lead", "deal", "case"] as const;
type Target = (typeof TARGETS)[number];

const TARGET_LABELS: Record<Target, string> = {
  party: "مشتری (پرونده)",
  lead: "سرنخ",
  deal: "فرصت فروش",
  case: "تیکت خدمات",
};

const TYPES = ["text", "number", "money", "boolean", "date", "select", "multi_select"] as const;
type FieldType = (typeof TYPES)[number];

const TYPE_LABELS: Record<FieldType, string> = {
  text: "متن",
  number: "عدد",
  money: "مبلغ",
  boolean: "بله / خیر",
  date: "تاریخ",
  select: "انتخاب یکی",
  multi_select: "انتخاب چند مورد",
};

interface FieldDefinition {
  id: string;
  target: Target;
  key: string;
  label: string;
  fieldType: FieldType;
  options: string[];
  isRequired: boolean;
  helpText: string;
  displayOrder: number;
  archivedAt: string | null;
}

interface Draft {
  id?: string;
  target: Target;
  label: string;
  fieldType: FieldType;
  options: string;
  isRequired: boolean;
  helpText: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  label_required: "نام فیلد الزامی است.",
  key_invalid: "این نوع فیلد یا کلید معتبر نیست.",
  key_taken: "فیلدی با همین کلید وجود دارد. نام دیگری انتخاب کنید.",
  type_change_blocked:
    "نوع این فیلد چون مقدار ثبت‌شده دارد تغییر نمی‌کند؛ به‌جایش فیلد را بایگانی و فیلد تازه بسازید.",
  options_required: "برای فیلد انتخابی، دست‌کم یک گزینه وارد کنید.",
  custom_field_target_invalid: "هدف فیلد نامعتبر است.",
  not_found: "این فیلد پیدا نشد.",
  bad_request: "درخواست نامعتبر بود.",
};

function messageFor(error: string | undefined, fallback: string): string {
  return (error && ERROR_MESSAGES[error]) || fallback;
}

export function BusinessFields({ canConfigure }: { canConfigure: boolean }) {
  const [groups, setGroups] = useState<{ target: Target; fields: FieldDefinition[] }[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setBusy(true);
    return api<{ groups: { target: Target; fields: FieldDefinition[] }[] }>("/api/crm/custom-fields").then(
      ({ ok, data, aborted }) => {
        if (aborted) return;
        if (ok) {
          setGroups(data.groups ?? []);
          setError("");
        } else {
          setError("بارگذاری فیلدهای کسب‌وکار ناموفق بود.");
        }
        setLoading(false);
        setBusy(false);
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ field?: FieldDefinition; error?: string }>("/api/crm/custom-fields", {
      method: "POST",
      body: JSON.stringify({
        id: draft.id,
        target: draft.target,
        label: draft.label,
        fieldType: draft.fieldType,
        options: draft.options
          .split(/[،,\n]/)
          .map((option) => option.trim())
          .filter(Boolean),
        isRequired: draft.isRequired,
        helpText: draft.helpText,
      }),
    });
    if (ok) {
      setNotice(draft.id ? "فیلد ذخیره شد." : "فیلد ساخته شد.");
      setDraft(null);
      await load();
      setBusy(false);
      return;
    }
    setError(messageFor(data.error, "ذخیرهٔ فیلد ناموفق بود."));
    setBusy(false);
  };

  const archive = async (field: FieldDefinition) => {
    if (busy) return;
    if (
      !window.confirm(
        `فیلد «${field.label}» بایگانی شود؟ از فرم‌ها برداشته می‌شود اما پاسخ‌های ثبت‌شده باقی می‌مانند.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/crm/custom-fields/${field.id}`, {
      method: "DELETE",
    });
    if (ok) {
      setNotice(`فیلد «${field.label}» بایگانی شد؛ پاسخ‌های ثبت‌شده دست‌نخورده ماندند.`);
      await load();
      setBusy(false);
      return;
    }
    setError(messageFor(data.error, "بایگانی فیلد ناموفق بود."));
    setBusy(false);
  };

  if (loading && !groups) {
    return <SectionCardSkeleton rows={4} label="در حال بارگذاری فیلدهای کسب‌وکار" />;
  }

  if (!groups) {
    return (
      <SectionCard title="فیلدهای کسب‌وکار">
        <ErrorBox>{error || "بارگذاری فیلدهای کسب‌وکار ناموفق بود."}</ErrorBox>
        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" onClick={() => load()} disabled={busy}>
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            تلاش دوباره
          </Button>
        </div>
      </SectionCard>
    );
  }

  const showOptions = draft?.fieldType === "select" || draft?.fieldType === "multi_select";

  return (
    <div className="space-y-3">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {canConfigure ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft({
              target: "party",
              label: "",
              fieldType: "text",
              options: "",
              isRequired: false,
              helpText: "",
            })
          }
          disabled={busy || draft !== null}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          فیلد تازه
        </Button>
      ) : (
        <InfoBox>نمایش فیلدها؛ برای ساخت یا تغییر، دسترسی «تنظیمات ارتباط با مشتری» لازم است.</InfoBox>
      )}

      {draft ? (
        <div className="grid gap-3 rounded-2xl border border-border/80 p-3 sm:grid-cols-2">
          <Field label="این فیلد برای چه چیزی است؟">
            <select
              className={inputClass}
              value={draft.target}
              onChange={(event) => setDraft({ ...draft, target: event.target.value as Target })}
              disabled={Boolean(draft.id)}
            >
              {TARGETS.map((target) => (
                <option key={target} value={target}>
                  {TARGET_LABELS[target]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="نام فیلد" hint="چیزی که کاربر می‌بیند؛ مثل «شمارهٔ قرارداد».">
            <input
              className={inputClass}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </Field>
          <Field
            label="نوع"
            hint={
              draft.id
                ? "نوع فیلدی که مقدار دارد تغییر نمی‌کند."
                : "پس از ثبت اولین مقدار، نوع قابل تغییر نیست."
            }
          >
            <select
              className={inputClass}
              value={draft.fieldType}
              onChange={(event) => setDraft({ ...draft, fieldType: event.target.value as FieldType })}
              disabled={Boolean(draft.id)}
              aria-label="نوع فیلد"
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="کمک زیر فیلد" hint="اختیاری — یک جمله که پر کردن را روشن می‌کند.">
            <input
              className={inputClass}
              value={draft.helpText}
              onChange={(event) => setDraft({ ...draft, helpText: event.target.value })}
            />
          </Field>
          {showOptions ? (
            <Field label="گزینه‌ها" hint="با ویرگول یا خط تازه جدا کنید.">
              <textarea
                className={`${inputClass} h-24 py-2`}
                value={draft.options}
                onChange={(event) => setDraft({ ...draft, options: event.target.value })}
              />
            </Field>
          ) : null}
          <Field label="اجباری؟">
            <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={draft.isRequired}
                onChange={(event) => setDraft({ ...draft, isRequired: event.target.checked })}
              />
              پر کردن این فیلد الزامی باشد
            </label>
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="button" size="sm" onClick={save} disabled={busy}>
              {busy ? "در حال ذخیره…" : "ذخیرهٔ فیلد"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={busy}>
              انصراف
            </Button>
          </div>
        </div>
      ) : null}

      {groups.every((group) => group.fields.length === 0) ? (
        <EmptyState>
          هنوز فیلد کسب‌وکاری ساخته نشده است. فیلدها همان سؤال‌هایی هستند که این کسب‌وکار می‌پرسد و
          اسکلت پیش‌فرض آن‌ها را ندارد.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {groups
            .filter((group) => group.fields.length > 0)
            .map((group) => (
              <div key={group.target} className="min-w-0">
                <p className="mb-2 text-sm font-semibold text-foreground">{TARGET_LABELS[group.target]}</p>
                <ul className="divide-y divide-border/80">
                  {group.fields.map((field) => (
                    <li key={field.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                          <span className="font-medium">{field.label}</span>
                          <StatusBadge tone="neutral">{TYPE_LABELS[field.fieldType]}</StatusBadge>
                          {field.isRequired ? <StatusBadge tone="active">اجباری</StatusBadge> : null}
                          {field.archivedAt ? <StatusBadge tone="neutral">بایگانی‌شده</StatusBadge> : null}
                        </p>
                        {field.helpText ? (
                          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{field.helpText}</p>
                        ) : null}
                        {field.options.length > 0 ? (
                          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                            {formatPersianNumber(field.options.length)} گزینه: {field.options.join("، ")}
                          </p>
                        ) : null}
                      </div>
                      {canConfigure && !field.archivedAt ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`ویرایش ${field.label}`}
                            onClick={() =>
                              setDraft({
                                id: field.id,
                                target: field.target,
                                label: field.label,
                                fieldType: field.fieldType,
                                options: field.options.join("، "),
                                isRequired: field.isRequired,
                                helpText: field.helpText,
                              })
                            }
                            disabled={busy}
                          >
                            <PencilIcon aria-hidden="true" className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`بایگانی ${field.label}`}
                            onClick={() => archive(field)}
                            disabled={busy}
                          >
                            <ArchiveIcon aria-hidden="true" className="size-4" />
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
