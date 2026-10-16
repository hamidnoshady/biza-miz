/**
 * Issue #868 — trading attribution rules («انتساب تحلیلی»): the management
 * surface for `accounting_dimension_mappings`, the table PR #898 shipped with a
 * service and a posting-time resolver but no API or UI of its own. A rule
 * answers "which dimension tuple does a purchase/sale line inherit when it
 * carries none of its own": item → product category → supplier → sales channel,
 * first match winning at posting time.
 *
 * This is the missing surface for that one table — no new section, no second
 * store. A rule is configuration: postings stamp resolved values on journal
 * lines and never point back at a rule, so editing or deleting one here never
 * changes posted history.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PencilIcon, PlusIcon, TrashIcon } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { ErrorBox, Field, InfoBox, SecondaryButton, api, inputClass } from "@/app/dashboard/ui";
import {
  DIMENSION_KINDS,
  dimensionErrorMessage,
  type DimensionKind,
  type DimensionValueRecord,
} from "@/lib/accounting-dimensions";
import { DimensionFields, useDimensionCatalog } from "./dimension-fields";
import {
  dimensionValueLabel,
  enabledDimensionKinds,
  isoToJalaliText,
  type DimensionDraft,
} from "./dimension-catalog";

/** The trading scopes `resolveTradingAttribution` knows, in precedence order. */
export type MappingScope = "item" | "product_category" | "supplier" | "sales_channel";

const SCOPE_LABEL: Record<MappingScope, string> = {
  item: "کالا",
  product_category: "دستهٔ کالا",
  supplier: "تأمین‌کننده",
  sales_channel: "کانال فروش",
};

const SCOPE_ORDER: readonly MappingScope[] = ["item", "product_category", "supplier", "sales_channel"];

export interface MappingRecord {
  id: string;
  scope: MappingScope;
  ref: string;
  dimensions: Partial<Record<DimensionKind, string | null>>;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string | null;
  updatedAt: string;
}

interface MappingForm {
  id?: string;
  scope: MappingScope;
  ref: string;
  dims: DimensionDraft;
  effectiveFrom: string;
  effectiveTo: string;
  isActive: boolean;
  note: string;
}

function draftFrom(dimensions: MappingRecord["dimensions"]): DimensionDraft {
  const draft: DimensionDraft = {};
  for (const kind of DIMENSION_KINDS) {
    const id = dimensions[kind];
    if (id) draft[kind] = id;
  }
  return draft;
}

function blankForm(): MappingForm {
  return { scope: "item", ref: "", dims: {}, effectiveFrom: "", effectiveTo: "", isActive: true, note: "" };
}

function formFrom(mapping: MappingRecord): MappingForm {
  return {
    id: mapping.id,
    scope: mapping.scope,
    ref: mapping.ref,
    dims: draftFrom(mapping.dimensions),
    effectiveFrom: mapping.effectiveFrom ?? "",
    effectiveTo: mapping.effectiveTo ?? "",
    isActive: mapping.isActive,
    note: mapping.note ?? "",
  };
}

function rangeText(mapping: MappingRecord): string {
  if (!mapping.effectiveFrom && !mapping.effectiveTo) return "همیشه";
  const from = mapping.effectiveFrom ? isoToJalaliText(mapping.effectiveFrom) : "…";
  const to = mapping.effectiveTo ? isoToJalaliText(mapping.effectiveTo) : "…";
  return `${from} تا ${to}`;
}

/** The server's `{error}` code → the same Persian wording the manager uses. */
function apiErrorText(data: Record<string, unknown>, fallback: string): string {
  const code = typeof data.error === "string" ? data.error : "";
  return code ? dimensionErrorMessage(code) ?? fallback : fallback;
}

export function DimensionMappingsTab({ values, canManage }: { values: DimensionValueRecord[]; canManage: boolean }) {
  const { catalog, loaded: catalogLoaded, error: catalogError, retry: retryCatalog } = useDimensionCatalog();
  const dimKindsOn = catalog ? enabledDimensionKinds(catalog.settings) : [];

  const [mappings, setMappings] = useState<MappingRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<MappingForm | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ mappings?: MappingRecord[] }>("/api/ledger/dimensions/mappings");
    if (res.ok) {
      setMappings(res.data.mappings ?? []);
      setLoadError("");
    } else {
      setLoadError("فهرست انتساب تحلیلی بارگذاری نشد.");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Value-id → "code · name" for the tuple columns; archived values are marked. */
  const valueLabel = useMemo(
    () => (id: string | null | undefined) => dimensionValueLabel(values, id),
    [values],
  );

  async function save() {
    if (!form || !form.ref.trim()) {
      setFormError("شناسه/کد مرجع را وارد کنید.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const body = {
        scope: form.scope,
        ref: form.ref.trim(),
        dimensions: Object.fromEntries(
          DIMENSION_KINDS.map((kind) => [kind, form.dims[kind] || null]),
        ),
        isActive: form.isActive,
        effectiveFrom: form.effectiveFrom || null,
        effectiveTo: form.effectiveTo || null,
        note: form.note.trim() || null,
      };
      const res = form.id
        ? await api(`/api/ledger/dimensions/mappings/${form.id}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : await api("/api/ledger/dimensions/mappings", {
            method: "POST",
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        setFormError(apiErrorText(res.data as Record<string, unknown>, "ذخیرهٔ قاعده انجام نشد."));
        return;
      }
      setNotice(form.id ? "قاعده به‌روزرسانی شد." : "قاعده ثبت شد.");
      setForm(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(mapping: MappingRecord) {
    setBusy(true);
    try {
      const res = await api(`/api/ledger/dimensions/mappings/${mapping.id}`, { method: "DELETE" });
      if (!res.ok) {
        setNotice("");
        setLoadError(apiErrorText(res.data as Record<string, unknown>, "حذف قاعده انجام نشد."));
        return;
      }
      setNotice("قاعده حذف شد. سوابق ثبت‌شده تغییری نمی‌کنند.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <InfoBox>
        این قاعده‌ها انتساب ابعاد تحلیلی سطرهای خرید/فروش را هنگام ثبت تعیین می‌کنند (کالا ← دسته ← تأمین‌کننده ← کانال فروش، اولین تطبیق برنده).
        انتساب صریح روی سطر همیشه مقدم است و سوابق ثبت‌شده تغییر نمی‌کنند.
      </InfoBox>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">قاعده‌های انتساب تحلیلی</h2>
        {canManage ? (
          <SecondaryButton
            disabled={busy}
            onClick={() => {
              setForm(blankForm());
              setFormError("");
            }}
          >
            <PlusIcon aria-hidden="true" className="size-4" />
            افزودن قاعده
          </SecondaryButton>
        ) : null}
      </div>

      {loadError ? <ErrorBox>{loadError}</ErrorBox> : null}

      {!loaded ? (
        <LoadingSkeleton rows={3} label="در حال بارگذاری قاعده‌های انتساب تحلیلی" />
      ) : (
      <DataTable caption="قاعده‌های انتساب تحلیلی">
        <DataTableHead>
          <Th>دامنه</Th>
          <Th>مرجع</Th>
          <Th>انتساب</Th>
          <Th>اعتبار</Th>
          <Th>وضعیت</Th>
          {canManage ? <Th>عملیات</Th> : null}
        </DataTableHead>
        <DataTableBody>
          {mappings.length === 0 ? (
            <DataTableRow>
              <Td muted colSpan={canManage ? 6 : 5}>
                {canManage
                  ? "هنوز قاعده‌ای ثبت نشده است. با «افزودن قاعده» انتساب ابعاد سطرهای خرید/فروش را تعیین کنید."
                  : "قاعده‌ای برای انتساب تحلیلی تعریف نشده است."}
              </Td>
            </DataTableRow>
          ) : (
            mappings
              .slice()
              .sort(
                (a, b) =>
                  SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) ||
                  a.ref.localeCompare(b.ref),
              )
              .map((m) => (
                <DataTableRow key={m.id} className={m.isActive ? undefined : "opacity-70"}>
                  <Td>{SCOPE_LABEL[m.scope]}</Td>
                  <Td nowrap dir="ltr">{m.ref}</Td>
                  <Td className="text-xs leading-6">
                    {DIMENSION_KINDS.filter((k) => m.dimensions[k]).map((k) => (
                      <div key={k}>{valueLabel(m.dimensions[k])}</div>
                    ))}
                    {DIMENSION_KINDS.every((k) => !m.dimensions[k]) ? "—" : null}
                  </Td>
                  <Td muted nowrap>{rangeText(m)}</Td>
                  <Td>
                    <StatusBadge tone={m.isActive ? "positive" : "neutral"}>
                      {m.isActive ? "فعال" : "بایگانی‌شده"}
                    </StatusBadge>
                  </Td>
                  {canManage ? (
                    <Td nowrap>
                      <div className="flex flex-wrap gap-2">
                        <SecondaryButton
                          disabled={busy}
                          onClick={() => {
                            setForm(formFrom(m));
                            setFormError("");
                          }}
                        >
                          <PencilIcon aria-hidden="true" className="size-4" />
                          ویرایش
                        </SecondaryButton>
                        <SecondaryButton disabled={busy} onClick={() => void remove(m)}>
                          <TrashIcon aria-hidden="true" className="size-4" />
                          حذف
                        </SecondaryButton>
                      </div>
                    </Td>
                  ) : null}
                </DataTableRow>
              ))
          )}
        </DataTableBody>
      </DataTable>
      )}

      {form ? (
        <div className="rounded-2xl border border-border/80 bg-background/60 p-4 space-y-3">
          <h3 className="text-sm font-semibold">{form.id ? "ویرایش قاعده" : "قاعدهٔ جدید"}</h3>
          {catalogError ? (
            <ErrorBox>
              ابعاد تحلیلی بارگذاری نشد؛ بدون نمایش آن‌ها این فرم را ذخیره نکنید.{" "}
              <button type="button" className="font-medium underline" onClick={retryCatalog}>
                تلاش دوباره
              </button>
            </ErrorBox>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="دامنه">
              <select
                className={inputClass}
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as MappingScope })}
              >
                {SCOPE_ORDER.map((s) => (
                  <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
                ))}
              </select>
            </Field>
            <Field label="شناسه/کد مرجع">
              <input
                className={inputClass}
                dir="ltr"
                value={form.ref}
                onChange={(e) => setForm({ ...form, ref: e.target.value })}
                placeholder={form.scope === "item" ? "SKU / کد کالا" : form.scope === "product_category" ? "کد دسته" : form.scope === "supplier" ? "شناسهٔ تأمین‌کننده" : "کد کانال"}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                دقیقاً همان مقداری که روی سطر خرید/فروش می‌نشیند؛ مقایسه بدون حساسیت به حروف است.
              </p>
            </Field>
          </div>
          <DimensionFields
            idPrefix="mapping-form"
            catalog={catalog}
            locationId={null}
            value={form.dims}
            onChange={(next) => setForm({ ...form, dims: next })}
            rowLabel="انتساب"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="block min-w-0">
              <span className="mb-1.5 block text-sm font-medium text-foreground">معتبر از</span>
              <JalaliDatePicker
                value={form.effectiveFrom}
                onChange={(next) => setForm({ ...form, effectiveFrom: next })}
                ariaLabel="معتبر از"
                placeholder="همیشه"
              />
            </div>
            <div className="block min-w-0">
              <span className="mb-1.5 block text-sm font-medium text-foreground">معتبر تا</span>
              <JalaliDatePicker
                value={form.effectiveTo}
                onChange={(next) => setForm({ ...form, effectiveTo: next })}
                ariaLabel="معتبر تا"
                placeholder="بدون پایان"
              />
            </div>
          </div>
          <Field label="یادداشت">
            <input
              className={inputClass}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Switch
              checked={form.isActive}
              onCheckedChange={(checked) => setForm({ ...form, isActive: checked })}
              aria-label="قاعده فعال باشد"
            />
            <span className="text-sm text-foreground">فعال</span>
          </div>
          {formError ? <ErrorBox>{formError}</ErrorBox> : null}
          <div className="flex flex-wrap gap-2">
            <SecondaryButton disabled={busy} onClick={() => void save()}>
              ذخیره
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={() => setForm(null)}>
              انصراف
            </SecondaryButton>
          </div>
          {!catalogLoaded && !catalogError ? (
            <LoadingSkeleton rows={1} compact label="در حال بارگذاری ابعاد تحلیلی" />
          ) : dimKindsOn.length === 0 && DIMENSION_KINDS.every((k) => !form.dims[k]) ? (
            <p className="text-xs text-muted-foreground">
              هیچ بُعدی فعال نیست؛ این قاعده انتسابی نخواهد داشت. از تب «مدیریت ابعاد» یک بُعد را فعال کنید.
            </p>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
