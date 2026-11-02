"use client";

/**
 * Issue #1207 §B — the contextual «ویرایش» action, which the products screen
 * did not have at all.
 *
 * The gap analysis found the section could open stock/price, descriptions,
 * the store review and the duplicate review, but never the product's own
 * identity fields: a wrong SKU or a missing barcode meant a trip through
 * another screen. The write path already existed — `PATCH
 * /api/products/items/[id]/meta`, the same one «توضیحات و انتشار» uses — so
 * this panel is only the missing form.
 *
 * What it deliberately does *not* do, because each has an owner already:
 *
 *  - stock and price stay on «ورود کالا / قیمت» (the trade's own stock route);
 *  - descriptions and publish status stay on «توضیحات و انتشار»;
 *  - nothing here reaches a store. A SKU change is local: it does not re-link,
 *    rename or re-publish the WooCommerce product, and the hint says so, so an
 *    owner cannot believe an edit is a store update. Store changes still go
 *    through «به‌روزرسانی دستی» with its review and acknowledgement.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, Field, inputClass } from "../ui";
import type { VariantSummary } from "@/lib/accessories-service";

/** The fields this panel owns, as the PATCH body spells them. */
interface EditValue {
  name: string;
  sku: string;
  barcode: string;
  unit: string;
}

function initialValue(item: VariantSummary): EditValue {
  return {
    name: item.name,
    sku: item.sku ?? "",
    barcode: item.barcode ?? "",
    unit: item.unit ?? "",
  };
}

/** Only what actually changed — the PATCH is a patch, not a replacement. */
export function changedFields(before: EditValue, after: EditValue): Partial<Record<keyof EditValue, string | null>> {
  const patch: Partial<Record<keyof EditValue, string | null>> = {};
  if (after.name.trim() !== before.name.trim()) patch.name = after.name.trim();
  // The three optional codes clear to NULL rather than to an empty string:
  // an empty SKU is "no code", and `NULLIF(btrim(sku), '')` treats them the
  // same everywhere else, but writing '' would leave two spellings in the data.
  for (const key of ["sku", "barcode", "unit"] as const) {
    if (after[key].trim() !== before[key].trim()) patch[key] = after[key].trim() || null;
  }
  return patch;
}

export function ProductEditPanel({
  item,
  busy,
  setBusy,
  onSaved,
}: {
  item: VariantSummary;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const before = initialValue(item);
  const [value, setValue] = useState<EditValue>(before);
  const [error, setError] = useState("");
  const patch = changedFields(before, value);
  const dirty = Object.keys(patch).length > 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !dirty) return;
    if (!value.name.trim()) {
      setError("نام محصول نمی‌تواند خالی باشد.");
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; field?: string; message?: string }>(
      `/api/products/items/${item.id}/meta`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    setBusy(false);
    if (!ok) {
      setError(
        data.error === "missing_fields"
          ? "نام محصول نمی‌تواند خالی باشد."
          : data.error === "item_not_found"
            ? "این محصول دیگر در این شعبه نیست؛ فهرست را تازه کنید."
            : data.message?.trim() || errorMessage(data.error),
      );
      return;
    }
    onSaved();
  }

  return (
    <form
      onSubmit={save}
      className="rounded-xl border border-amber-200/70 bg-amber-50/60 p-3 sm:p-4 dark:border-amber-500/25 dark:bg-amber-500/10"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-sm font-semibold text-amber-950 dark:text-amber-200">ویرایش محصول</p>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.name}</p>
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="نام محصول">
          <input
            className={inputClass}
            aria-label="نام محصول"
            value={value.name}
            disabled={busy}
            maxLength={200}
            onChange={(event) => {
              setError("");
              setValue((current) => ({ ...current, name: event.target.value }));
            }}
          />
        </Field>
        <Field
          label="کد کالا (SKU)"
          hint="کد کالا یک فیلد محلی است: تغییر آن محصول فروشگاه را تغییر نمی‌دهد و پیوند را جابه‌جا نمی‌کند."
        >
          <input
            className={inputClass}
            aria-label="کد کالا"
            dir="ltr"
            value={value.sku}
            disabled={busy}
            maxLength={64}
            onChange={(event) => {
              setError("");
              setValue((current) => ({ ...current, sku: event.target.value }));
            }}
          />
        </Field>
        <Field label="بارکد">
          <input
            className={inputClass}
            aria-label="بارکد"
            dir="ltr"
            value={value.barcode}
            disabled={busy}
            maxLength={64}
            onChange={(event) => {
              setError("");
              setValue((current) => ({ ...current, barcode: event.target.value }));
            }}
          />
        </Field>
        <Field label="واحد اصلی">
          <input
            className={inputClass}
            aria-label="واحد اصلی"
            value={value.unit}
            disabled={busy}
            maxLength={40}
            onChange={(event) => {
              setError("");
              setValue((current) => ({ ...current, unit: event.target.value }));
            }}
          />
        </Field>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        موجودی و قیمت از «ورود کالا / قیمت»، توضیحات و وضعیت انتشار از «توضیحات و انتشار» ویرایش می‌شوند. هیچ‌کدام از
        این تغییرات به فروشگاه ارسال نمی‌شود؛ ارسال فروشگاه فقط با «به‌روزرسانی دستی» و پس از تأیید فروشگاه انجام
        می‌گیرد.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || !dirty} size="sm" className="min-h-9 px-4 font-semibold">
          {busy ? "در حال ذخیره…" : "ذخیرهٔ ویرایش"}
        </Button>
        {dirty && !busy ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-9 text-xs"
            onClick={() => {
              setError("");
              setValue(before);
            }}
          >
            بازگرداندن
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
