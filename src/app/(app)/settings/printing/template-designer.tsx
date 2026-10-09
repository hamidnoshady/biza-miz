"use client";

/**
 * The template designer — «طراحی قالب».
 *
 * The design goal was "easy but powerful", and those two pull in opposite
 * directions, so the screen resolves them by never showing a canvas. A drag-
 * anywhere WYSIWYG canvas is the obvious answer and the wrong one for this
 * product: a receipt is one column on a fixed-width roll, an invoice is a
 * header/table/totals stack, and free positioning on either only lets someone
 * build something that prints wrong. So the model is a *list of blocks* —
 * reorder with the arrow buttons, toggle each on or off, and set the handful
 * of things a block can differ in (alignment, size, bold, which table columns)
 * — with a real preview beside it that re-renders on every keystroke.
 *
 * That makes the whole editor keyboard- and touch-workable, works identically
 * on a phone (the preview stacks under the controls), and cannot produce a
 * template the renderer refuses.
 */
import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import {
  BLOCK_LABELS,
  HIDDEN_BLOCK_TYPES,
  DOC_TYPE_LABELS,
  ITEM_COLUMN_LABELS,
  PAPERS,
  PAPER_KEYS,
  type Align,
  type BlockType,
  type DocType,
  type ItemColumn,
  type PaperKey,
  type PrintDocumentData,
  type PrintTemplate,
  type TemplateBlock,
  type TextSize,
} from "@/lib/print-template";
import { SectionCard, cardClass } from "@/app/dashboard/page-chrome";
import { Field, inputClass } from "@/app/dashboard/ui";
import { TemplatePreview } from "./template-preview";
import { FilterChip } from "@/app/dashboard/filters";

const SIZE_LABELS: Record<TextSize, string> = {
  xs: "خیلی کوچک",
  sm: "کوچک",
  md: "معمولی",
  lg: "بزرگ",
  xl: "خیلی بزرگ",
};

const ALIGN_LABELS: Record<Align, string> = { start: "راست", center: "وسط", end: "چپ" };

/**
 * Blocks a person can add. `items`/`totals` may appear more than once safely.
 *
 * `qr` is deliberately absent (see `HIDDEN_BLOCK_TYPES` in print-template.ts):
 * no document supplies a QR payload yet, and offering a control whose output
 * the renderer would drop is exactly the drift this model exists to prevent.
 * `labelFields` is here because the label pipeline is now a template like any
 * other.
 */
const ADDABLE: BlockType[] = (Object.keys(BLOCK_LABELS) as BlockType[]).filter(
  (type) => !HIDDEN_BLOCK_TYPES.includes(type),
);

function newBlock(type: BlockType): TemplateBlock {
  const base: TemplateBlock = { id: crypto.randomUUID(), type, visible: true };
  if (type === "items") return { ...base, columns: ["name", "qty", "total"] };
  if (type === "spacer") return { ...base, heightMm: 4 };
  if (type === "logo") return { ...base, align: "center", logoHeightMm: 14 };
  if (type === "text") return { ...base, align: "center", size: "sm", text: "" };
  if (type === "signature") return { ...base, text: "مهر و امضای فروشنده|مهر و امضای خریدار" };
  return base;
}

export function TemplateDesigner({
  value,
  onChange,
  data,
  onSave,
  onCancel,
  saving,
  savedLabel,
}: {
  value: PrintTemplate;
  onChange: (next: PrintTemplate) => void;
  data: PrintDocumentData;
  onSave: (isDefault: boolean) => void;
  onCancel: () => void;
  saving: boolean;
  /** Shown on the save button: «ذخیره» for an edit, «ساخت قالب» for a new one. */
  savedLabel: string;
}) {
  const [makeDefault, setMakeDefault] = useState(false);
  const [adding, setAdding] = useState<BlockType>("text");

  const paperOptions = useMemo(
    () => PAPER_KEYS.map((key) => ({ value: key, label: PAPERS[key].label, searchString: `${PAPERS[key].label} ${PAPERS[key].hint}` })),
    [],
  );

  function patch(next: Partial<PrintTemplate>) {
    onChange({ ...value, ...next });
  }

  function patchBlock(id: string, next: Partial<TemplateBlock>) {
    patch({ blocks: value.blocks.map((b) => (b.id === id ? { ...b, ...next } : b)) });
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= value.blocks.length) return;
    const blocks = [...value.blocks];
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    patch({ blocks });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start">
      <div className="space-y-4">
        <SectionCard title="مشخصات قالب" description="نام، نوع سند و کاغذی که این قالب برای آن طراحی می‌شود.">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="نام قالب">
              <input
                className={inputClass}
                value={value.name}
                maxLength={80}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="مثلاً فاکتور مشتریان شرکتی"
              />
            </Field>
            <Field label="نوع سند">
              <SearchableSelect
                value={value.docType}
                onChange={(next) => patch({ docType: next as DocType })}
                options={(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((key) => ({ value: key, label: DOC_TYPE_LABELS[key] }))}
              />
            </Field>
            <Field label="کاغذ" hint={PAPERS[value.paper].hint}>
              <SearchableSelect
                value={value.paper}
                onChange={(next) => patch({ paper: next as PaperKey, options: { ...value.options, marginMm: PAPERS[next as PaperKey].marginMm } })}
                options={paperOptions}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard title="ظاهر کلی" description="اندازهٔ متن، فاصلهٔ خطوط، حاشیه و ضخامت چاپ. برای چاپگر حرارتی ضخامت بیشتر خواناتر است.">
          <div className="grid gap-4 sm:grid-cols-2">
            <SliderField
              label="اندازهٔ متن"
              value={value.options.fontScale}
              min={0.6}
              max={2}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}٪`}
              onChange={(fontScale) => patch({ options: { ...value.options, fontScale } })}
            />
            <SliderField
              label="فاصلهٔ خطوط"
              value={value.options.lineHeight}
              min={1}
              max={2.4}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(lineHeight) => patch({ options: { ...value.options, lineHeight } })}
            />
            <SliderField
              label="حاشیهٔ کاغذ (میلی‌متر)"
              value={value.options.marginMm}
              min={0}
              max={30}
              step={1}
              format={(v) => `${v}`}
              onChange={(marginMm) => patch({ options: { ...value.options, marginMm } })}
            />
            <Field label="ضخامت چاپ">
              <SearchableSelect
                value={String(value.options.bodyWeight)}
                onChange={(next) => patch({ options: { ...value.options, bodyWeight: Number(next) as 400 | 500 | 600 | 700 } })}
                options={[
                  { value: "400", label: "نازک" },
                  { value: "500", label: "معمولی" },
                  { value: "600", label: "نیمه‌ضخیم" },
                  { value: "700", label: "ضخیم (چاپگر حرارتی)" },
                ]}
              />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-3 border-t border-border/80 pt-4">
            <ToggleRow
              label="نمایش واحد پول کنار مبلغ نهایی"
              checked={value.options.showUnit}
              onChange={(showUnit) => patch({ options: { ...value.options, showUnit } })}
            />
            {PAPERS[value.paper].kind !== "thermal" ? (
              <ToggleRow
                label="چاپ دو نسخه (خریدار و فروشنده)"
                checked={value.options.copies === 2}
                onChange={(two) => patch({ options: { ...value.options, copies: two ? 2 : 1 } })}
              />
            ) : null}
          </div>
        </SectionCard>

        <SectionCard
          title="بخش‌های سند"
          description="ترتیب را با فلش‌ها تغییر دهید، هر بخش را خاموش یا روشن کنید و تنظیمات آن را از همین‌جا بردارید."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-48">
                <SearchableSelect
                  value={adding}
                  onChange={(next) => setAdding(next as BlockType)}
                  ariaLabel="بخش برای افزودن"
                  options={ADDABLE.map((type) => ({ value: type, label: BLOCK_LABELS[type] }))}
                />
              </div>
              <Button type="button" variant="outline" onClick={() => patch({ blocks: [...value.blocks, newBlock(adding)] })}>
                <PlusIcon aria-hidden="true" />
                افزودن
              </Button>
            </div>
          }
        >
          <ul className="space-y-2">
            {value.blocks.map((block, index) => (
              <li key={block.id}>
                <BlockEditor
                  block={block}
                  first={index === 0}
                  last={index === value.blocks.length - 1}
                  onMove={(delta) => move(index, delta)}
                  onPatch={(next) => patchBlock(block.id, next)}
                  onRemove={() => patch({ blocks: value.blocks.filter((b) => b.id !== block.id) })}
                />
              </li>
            ))}
          </ul>
        </SectionCard>

        <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
          <ToggleRow
            label={`پیش‌فرض «${DOC_TYPE_LABELS[value.docType]}» شود`}
            checked={makeDefault}
            onChange={setMakeDefault}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              انصراف
            </Button>
            <Button type="button" onClick={() => onSave(makeDefault)} disabled={saving || !value.name.trim()}>
              {saving ? "در حال ذخیره…" : savedLabel}
            </Button>
          </div>
        </div>
      </div>

      {/* The preview follows on a phone and pins beside the controls from `lg` up. */}
      <div className="lg:sticky lg:top-4">
        <SectionCard title="پیش‌نمایش زنده" description="همان چیزی که چاپ می‌شود — با اندازهٔ واقعی کاغذ.">
          <TemplatePreview template={value} data={data} maxHeightPx={560} />
        </SectionCard>
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <Switch checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 flex items-center justify-between text-sm font-medium text-foreground">
        {label}
        <span className="text-xs text-muted-foreground">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-11 w-full accent-primary"
      />
    </label>
  );
}

function BlockEditor({
  block,
  first,
  last,
  onMove,
  onPatch,
  onRemove,
}: {
  block: TemplateBlock;
  first: boolean;
  last: boolean;
  onMove: (delta: number) => void;
  onPatch: (next: Partial<TemplateBlock>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const configurable = !["divider"].includes(block.type);

  return (
    <div className={`rounded-xl border ${block.visible ? "border-border/80" : "border-dashed border-border"} bg-card`}>
      <div className="flex flex-wrap items-center gap-2 p-2">
        <div className="flex shrink-0">
          <Button type="button" variant="ghost" size="icon" aria-label="انتقال به بالا" disabled={first} onClick={() => onMove(-1)}>
            <ArrowUpIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="انتقال به پایین" disabled={last} onClick={() => onMove(1)}>
            <ArrowDownIcon aria-hidden="true" />
          </Button>
        </div>
        <button
          type="button"
          onClick={() => configurable && setOpen((prev) => !prev)}
          className={`min-w-0 flex-1 rounded-lg px-2 py-2 text-right text-sm transition-colors ${configurable ? "hover:bg-muted" : "cursor-default"} ${block.visible ? "text-foreground" : "text-muted-foreground"}`}
        >
          {BLOCK_LABELS[block.type]}
          {block.type === "text" && block.text ? <span className="mr-2 text-xs text-muted-foreground">«{block.text.slice(0, 24)}»</span> : null}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={block.visible ? "پنهان‌کردن این بخش" : "نمایش این بخش"}
          onClick={() => onPatch({ visible: !block.visible })}
        >
          {block.visible ? <EyeIcon aria-hidden="true" /> : <EyeOffIcon aria-hidden="true" />}
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label="حذف بخش" onClick={onRemove}>
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>

      {open && configurable ? (
        <div className="grid gap-x-4 border-t border-border/80 p-3 sm:grid-cols-2">
          {block.type !== "spacer" ? (
            <>
              <Field label="چینش">
                <SearchableSelect
                  value={block.align ?? "start"}
                  onChange={(next) => onPatch({ align: next as Align })}
                  options={(Object.keys(ALIGN_LABELS) as Align[]).map((key) => ({ value: key, label: ALIGN_LABELS[key] }))}
                />
              </Field>
              <Field label="اندازهٔ متن">
                <SearchableSelect
                  value={block.size ?? "md"}
                  onChange={(next) => onPatch({ size: next as TextSize })}
                  options={(Object.keys(SIZE_LABELS) as TextSize[]).map((key) => ({ value: key, label: SIZE_LABELS[key] }))}
                />
              </Field>
              <div className="mb-4 flex items-center">
                <ToggleRow label="درشت (Bold)" checked={block.bold === true} onChange={(bold) => onPatch({ bold })} />
              </div>
            </>
          ) : null}

          {block.type === "spacer" ? (
            <Field label="ارتفاع (میلی‌متر)">
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                value={block.heightMm ?? 4}
                onChange={(e) => onPatch({ heightMm: Number(e.target.value) })}
              />
            </Field>
          ) : null}

          {block.type === "logo" ? (
            <Field label="ارتفاع لوگو (میلی‌متر)" hint="لوگو از پروفایل کسب‌وکار خوانده می‌شود.">
              <PersianNumberInput
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                className={inputClass}
                value={block.logoHeightMm ?? 14}
                onChange={(e) => onPatch({ logoHeightMm: Number(e.target.value) })}
              />
            </Field>
          ) : null}

          {block.type === "text" ? (
            <Field label="متن" hint="خالی بگذارید تا «پیام پایان رسید» از تنظیمات کسب‌وکار چاپ شود.">
              <textarea
                className={`${inputClass} h-20 py-2`}
                maxLength={400}
                value={block.text ?? ""}
                onChange={(e) => onPatch({ text: e.target.value })}
              />
            </Field>
          ) : null}

          {block.type === "signature" ? (
            <Field label="عنوان دو محل امضا" hint="با علامت | از هم جدا کنید.">
              <input
                className={inputClass}
                maxLength={120}
                value={block.text ?? ""}
                onChange={(e) => onPatch({ text: e.target.value })}
              />
            </Field>
          ) : null}

          {block.type === "items" ? (
            <div className="sm:col-span-2 mb-4">
              <span className="mb-2 block text-sm font-medium text-foreground">ستون‌های جدول</span>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(ITEM_COLUMN_LABELS) as ItemColumn[]).map((column) => {
                  const active = (block.columns ?? []).includes(column);
                  return (
                    <FilterChip
                      key={column}
                      selected={active}
                      onClick={() =>
                        onPatch({
                          columns: active
                            ? (block.columns ?? []).filter((c) => c !== column)
                            : [...(block.columns ?? []), column],
                        })
                      }
                      className="min-h-9 text-xs"
                    >
                      {ITEM_COLUMN_LABELS[column]}
                    </FilterChip>
                  );
                })}
              </div>
              <div className="mt-3">
                <ToggleRow
                  label="جدول خط‌کشی‌شده (مناسب فاکتور A4 و A5)"
                  checked={block.ruled === true}
                  onChange={(ruled) => onPatch({ ruled })}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
