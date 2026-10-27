"use client";

/**
 * The storefront text of a product: publish status, short description and long
 * description, plus «نوشتن با هوش مصنوعی».
 *
 * One component, two homes — the «توضیحات و انتشار» tab of the add-product form
 * and the per-row editor in the product list — so the status vocabulary, the
 * limits and the AI behaviour cannot drift between creating a product and
 * editing one. The AI button only fills the two boxes; nothing is saved until
 * the owner saves the surrounding form, and a draft never silently replaces
 * text the owner already wrote (they confirm the overwrite).
 */
import { useState } from "react";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import {
  PRODUCT_LONG_DESCRIPTION_MAX,
  PRODUCT_PUBLISH_STATUSES,
  PRODUCT_PUBLISH_STATUS_HINTS,
  PRODUCT_PUBLISH_STATUS_LABELS,
  PRODUCT_SHORT_DESCRIPTION_MAX,
  type ProductPublishStatus,
} from "@/lib/product-content";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { useMoney } from "@/components/money/money-context";

export interface ProductContentValue {
  publishStatus: ProductPublishStatus;
  shortDescription: string;
  longDescription: string;
}

/** What the model may be told about the product — only facts the form already holds. */
export interface ProductContentFacts {
  name: string;
  sku?: string;
  unit?: string;
  attributes?: { name: string; value: string }[];
}

function Counter({ length, max }: { length: number; max: number }) {
  return (
    <span className={length > max ? "text-destructive" : "text-muted-foreground"}>
      {toPersianDigits(length)} / {toPersianDigits(max)}
    </span>
  );
}

export function ProductContentFields({
  value,
  onChange,
  facts,
  disabled = false,
  errors,
}: {
  value: ProductContentValue;
  onChange: (patch: Partial<ProductContentValue>) => void;
  facts: ProductContentFacts;
  disabled?: boolean;
  /** Per-field messages from the shared validator. */
  errors?: Partial<Record<"publishStatus" | "shortDescription" | "longDescription", string>>;
}) {
  const money = useMoney();
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const hasName = facts.name.trim().length > 0;

  async function generate() {
    if (!hasName || generating) return;
    const hasText = Boolean(value.shortDescription.trim() || value.longDescription.trim());
    setError("");
    setNotice("");
    setGenerating(true);
    try {
      const result = await api<{
        draft?: { shortDescription?: string; longDescription?: string };
        costRial?: number;
        message?: string;
        error?: string;
      }>("/api/products/items/describe", {
        method: "POST",
        body: JSON.stringify({
          name: facts.name,
          sku: facts.sku || undefined,
          unit: facts.unit || undefined,
          attributes: facts.attributes,
          existingShort: value.shortDescription || undefined,
          existingLong: value.longDescription || undefined,
          instruction: instruction.trim() || undefined,
        }),
      });
      if (!result.ok || !result.data.draft) {
        setError(result.data.message ?? "ساخت توضیح ممکن نشد؛ دوباره تلاش کنید.");
        return;
      }
      const draft = result.data.draft;
      if (
        hasText &&
        !window.confirm("متن فعلی با پیش‌نویس هوش مصنوعی جایگزین شود؟ می‌توانید پیش از ذخیره، آن را ویرایش کنید.")
      ) {
        return;
      }
      onChange({
        shortDescription: draft.shortDescription ?? value.shortDescription,
        longDescription: draft.longDescription ?? value.longDescription,
      });
      const cost = typeof result.data.costRial === "number" && result.data.costRial > 0 ? ` هزینه: ${money.format(result.data.costRial)}.` : "";
      setNotice(`پیش‌نویس در کادرها گذاشته شد؛ بخوانید، ویرایش کنید و سپس ذخیره کنید.${cost}`);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
        <Field label="وضعیت انتشار" hint={PRODUCT_PUBLISH_STATUS_HINTS[value.publishStatus]}>
          <select
            className={inputClass}
            aria-label="وضعیت انتشار"
            value={value.publishStatus}
            disabled={disabled}
            aria-invalid={Boolean(errors?.publishStatus)}
            onChange={(event) => onChange({ publishStatus: event.target.value as ProductPublishStatus })}
          >
            {PRODUCT_PUBLISH_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PRODUCT_PUBLISH_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          {errors?.publishStatus ? <p className="mt-1 text-xs text-destructive">{errors.publishStatus}</p> : null}
        </Field>
        <Field as="div" label="دستور برای هوش مصنوعی (اختیاری)" hint="مثلاً «لحن رسمی» یا «برای خریدار عمده».">
          <div className="flex gap-2">
            <input
              className={inputClass}
              aria-label="دستور برای هوش مصنوعی"
              value={instruction}
              maxLength={200}
              disabled={disabled || generating}
              onChange={(event) => setInstruction(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              disabled={disabled || generating || !hasName}
              onClick={() => void generate()}
            >
              <SparklesIcon aria-hidden="true" className="size-4" />
              {generating ? "در حال نوشتن…" : "نوشتن با هوش مصنوعی"}
            </Button>
          </div>
        </Field>
      </div>
      {!hasName ? <p className="text-xs text-muted-foreground">برای نوشتن با هوش مصنوعی ابتدا نام محصول را وارد کنید.</p> : null}
      <ErrorBox>{error}</ErrorBox>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <Field label="توضیح کوتاه" hint="خلاصهٔ یک یا دو جمله‌ای که بالای صفحهٔ محصول و در فهرست‌ها دیده می‌شود.">
        <textarea
          className={`${inputClass} min-h-24 resize-y`}
          aria-label="توضیح کوتاه"
          value={value.shortDescription}
          disabled={disabled}
          rows={3}
          aria-invalid={Boolean(errors?.shortDescription)}
          onChange={(event) => onChange({ shortDescription: event.target.value })}
        />
        <p className="mt-1 text-end text-[11px]">
          <Counter length={value.shortDescription.length} max={PRODUCT_SHORT_DESCRIPTION_MAX} />
        </p>
        {errors?.shortDescription ? <p className="text-xs text-destructive">{errors.shortDescription}</p> : null}
      </Field>
      <Field label="توضیح کامل" hint="متن کامل معرفی محصول؛ متن ساده، بدون HTML.">
        <textarea
          className={`${inputClass} min-h-48 resize-y`}
          aria-label="توضیح کامل"
          value={value.longDescription}
          disabled={disabled}
          rows={8}
          aria-invalid={Boolean(errors?.longDescription)}
          onChange={(event) => onChange({ longDescription: event.target.value })}
        />
        <p className="mt-1 text-end text-[11px]">
          <Counter length={value.longDescription.length} max={PRODUCT_LONG_DESCRIPTION_MAX} />
        </p>
        {errors?.longDescription ? <p className="text-xs text-destructive">{errors.longDescription}</p> : null}
      </Field>
    </div>
  );
}
