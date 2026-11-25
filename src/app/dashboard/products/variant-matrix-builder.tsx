"use client";

/**
 * «ساخت ماتریس تنوع» — the size × colour grid for the product form (#1567
 * P0 2.5). Two axes (attribute definition + values, one per line), a live
 * cell preview, and a generate button that appends one draft row per
 * combination — skipping combinations the form already holds and never
 * crossing the 100-variant ceiling.
 */
import { useMemo, useState } from "react";
import { Grid2X2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import {
  buildVariantDraftSeeds,
  parseAxisValues,
  type MatrixDraftSeed,
} from "@/lib/variant-matrix-draft";
import { Field, inputClass } from "../ui";
import { cardClass } from "../page-chrome";

export function VariantMatrixBuilder({
  definitions,
  existing,
  maxTotal,
  disabled,
  onGenerate,
}: {
  /** Only active definitions can anchor an axis — same rule as a variant row. */
  definitions: readonly AttributeDefinition[];
  /** Attribute-value sets the form already holds, for duplicate skipping. */
  existing: readonly MatrixDraftSeed[];
  /** The form's hard ceiling on total variant rows. */
  maxTotal: number;
  disabled?: boolean;
  /** Called with the cleaned seeds to append as draft rows. */
  onGenerate: (seeds: MatrixDraftSeed[], meta: { duplicates: number; truncated: number }) => void;
}) {
  const [axisAId, setAxisAId] = useState("");
  const [axisAText, setAxisAText] = useState("");
  const [axisBId, setAxisBId] = useState("");
  const [axisBText, setAxisBText] = useState("");
  const [error, setError] = useState("");

  const preview = useMemo(
    () =>
      buildVariantDraftSeeds({
        axisA: { definitionId: axisAId, values: parseAxisValues(axisAText) },
        axisB: axisBId ? { definitionId: axisBId, values: parseAxisValues(axisBText) } : undefined,
        existing,
        maxTotal,
      }),
    [axisAId, axisAText, axisBId, axisBText, existing, maxTotal],
  );

  const remaining = Math.max(0, maxTotal - existing.length);

  function generate() {
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    if (preview.seeds.length === 0) {
      setError(
        preview.duplicates > 0
          ? "همهٔ ترکیب‌های این ماتریس از قبل در فرم وجود دارد."
          : "ترکیبی برای ساختن باقی نمانده است.",
      );
      return;
    }
    setError("");
    onGenerate(preview.seeds, { duplicates: preview.duplicates, truncated: preview.truncated });
  }

  if (definitions.length === 0) return null;

  return (
    <section
      data-tour-id="product-new.matrix"
      className={`${cardClass} min-w-0 space-y-3 p-4`}
      aria-label="ساخت ماتریس تنوع"
    >
      <div className="flex items-center gap-2">
        <Grid2X2Icon aria-hidden="true" className="size-4 text-amber-700 dark:text-amber-300" />
        <h3 className="text-sm font-semibold text-foreground">ساخت ماتریس تنوع (سایز × رنگ)</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        هر ترکیب از دو محور یک ردیف تنوع می‌سازد. ترکیب‌هایی که از قبل در فرم هستند دوباره ساخته نمی‌شوند؛
        حداکثر {toPersianDigits(maxTotal)} تنوع در یک محصول.
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="محور اول (الزامی)">
          <select
            className={inputClass}
            value={axisAId}
            onChange={(event) => { setAxisAId(event.target.value); setError(""); }}
            aria-label="محور اول ماتریس"
          >
            <option value="">انتخاب ویژگی…</option>
            {definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>{definition.name}</option>
            ))}
          </select>
        </Field>
        <Field label="مقادیر محور اول" hint="هر خط یک مقدار؛ کاما هم جداکننده است.">
          <textarea
            className={`${inputClass} min-h-24`}
            value={axisAText}
            onChange={(event) => { setAxisAText(event.target.value); setError(""); }}
            placeholder={"M\nL\nXL"}
            aria-label="مقادیر محور اول"
            disabled={!axisAId}
          />
        </Field>
        <Field label="محور دوم (اختیاری)">
          <select
            className={inputClass}
            value={axisBId}
            onChange={(event) => { setAxisBId(event.target.value); setError(""); }}
            aria-label="محور دوم ماتریس"
          >
            <option value="">بدون محور دوم</option>
            {definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>{definition.name}</option>
            ))}
          </select>
        </Field>
        <Field label="مقادیر محور دوم" hint="خالی یعنی فقط محور اول.">
          <textarea
            className={`${inputClass} min-h-24`}
            value={axisBText}
            onChange={(event) => { setAxisBText(event.target.value); setError(""); }}
            placeholder={"مشکی\nسرمه‌ای"}
            aria-label="مقادیر محور دوم"
            disabled={!axisBId}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {preview.ok
            ? preview.seeds.length > 0
              ? `${toPersianDigits(preview.seeds.length)} تنوع ساخته می‌شود${preview.duplicates > 0 ? `؛ ${toPersianDigits(preview.duplicates)} تکراری رد می‌شود` : ""}${preview.truncated > 0 ? `؛ ${toPersianDigits(preview.truncated)} مورد به خاطر سقف ${toPersianDigits(maxTotal)} ردیف رد می‌شود` : ""}.`
              : preview.duplicates > 0
                ? "همهٔ ترکیب‌های این ماتریس از قبل در فرم وجود دارد."
                : "ترکیبی برای پیش‌نمایش نیست."
            : "ورودی ماتریس هنوز کامل نیست."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || remaining === 0 || !preview.ok || preview.seeds.length === 0}
          onClick={generate}
        >
          ساخت تنوع‌ها
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
