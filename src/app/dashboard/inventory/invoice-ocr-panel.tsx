"use client";

/**
 * Supplier-invoice camera / upload → AI OCR → review → fill the purchase form.
 *
 * The image never leaves this browser except as a one-shot data URL to
 * `/api/ai/invoice-ocr`. Nothing is auto-posted: the parent receives reviewed
 * draft lines and the operator still hits «ثبت پیش‌نویس خرید».
 */

import { useRef, useState } from "react";
import {
  CameraIcon,
  CheckCircle2Icon,
  FileImageIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { MAX_RECEIPT_IMAGE_BYTES, parseReceiptImageDataUrl } from "@/lib/ai-receipt";
import { LoadingSkeleton, SectionCard } from "../page-chrome";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, Field, inputClass } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { InventoryItem } from "./inventory-manager";

export interface InvoiceOcrDraftLine {
  inventoryItemId: string;
  purchaseQty: string;
  /** Toman (or display-unit) text the purchase form already edits. */
  totalCost: string;
  /** OCR source name, kept for the review list. */
  sourceName?: string;
}

export interface InvoiceOcrApplyPayload {
  supplierId: string;
  purchaseDate: string;
  note: string;
  lines: InvoiceOcrDraftLine[];
  /** The invoice photo's own Media Library asset id, once the scan route
   * stored it (migration 0179/0180) — carried through so the resulting
   * purchase draft can keep a durable pointer back to the photo it was
   * scanned from, the same way an expense keeps its receipt photo's id. */
  invoiceAssetId: string | null;
}

interface OcrLine {
  key: string;
  name: string;
  quantity: string | null;
  unit: string | null;
  lineTotalRial: number | null;
  barcode: string | null;
  confidence: number | null;
  matchStatus: "matched" | "ambiguous" | "unmatched";
  matchScore: number;
  inventoryItemId: string | null;
  inventoryItemName: string | null;
  purchaseUnit: string | null;
  candidates: Array<{ id: string; name: string; unit: string; purchaseUnit: string | null }>;
}

interface OcrResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  extraction?: {
    vendor: string | null;
    invoiceDate: string | null;
    invoiceNumber: string | null;
    totalRial: number | null;
    note: string;
  };
  lines?: OcrLine[];
  validation?: {
    verdict: "pass" | "warn" | "fail";
    summary: string;
    issues: string[];
    overallConfidence: number;
  };
  supplierId?: string | null;
  supplierName?: string | null;
  costRial?: number;
  asset?: { id: string } | null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read_failed"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("read_failed"));
    };
    reader.readAsDataURL(file);
  });
}

const VERDICT_STYLE: Record<
  "pass" | "warn" | "fail",
  { icon: typeof CheckCircle2Icon; box: string; label: string }
> = {
  pass: {
    icon: CheckCircle2Icon,
    box: "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-950 dark:text-emerald-50",
    label: "تأیید اولیه",
  },
  warn: {
    icon: TriangleAlertIcon,
    box: "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-950 dark:text-amber-200",
    label: "نیاز به بررسی",
  },
  fail: {
    icon: XCircleIcon,
    box: "border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-500/15 text-rose-950 dark:text-rose-50",
    label: "ناقص",
  },
};

export function InvoiceOcrPanel({
  items,
  supplierOptions,
  onApply,
  disabled,
}: {
  items: InventoryItem[];
  supplierOptions: Array<{ value: string; label: string }>;
  onApply: (payload: InvoiceOcrApplyPayload) => void;
  disabled?: boolean;
}) {
  const money = useMoney();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<OcrResponse | null>(null);

  // Editable review state (seeded from the OCR response).
  const [supplierId, setSupplierId] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<
    Array<OcrLine & { inventoryItemId: string; purchaseQty: string; totalCost: string; include: boolean }>
  >([]);

  const itemOptions = [
    { value: "", label: "انتخاب قلم انبار…" },
    ...items
      .filter((i) => i.is_active)
      .map((i) => ({
        value: i.id,
        label: i.name,
        searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
      })),
  ];

  function resetReview() {
    setResult(null);
    setLines([]);
    setSupplierId("");
    setPurchaseDate("");
    setNote("");
    setError("");
  }

  async function runOcr(file: File) {
    setError("");
    resetReview();

    if (!file.type.startsWith("image/")) {
      setError("فقط تصویر JPEG، PNG یا WebP پذیرفته می‌شود.");
      return;
    }
    if (file.size > MAX_RECEIPT_IMAGE_BYTES) {
      setError("حجم تصویر بیش از ۵ مگابایت است.");
      return;
    }

    setBusy(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      if (!parseReceiptImageDataUrl(dataUrl)) {
        setError("فرمت یا حجم تصویر پشتیبانی نمی‌شود.");
        setBusy(false);
        return;
      }
      setPreviewUrl(dataUrl);

      const { ok, data } = await api<OcrResponse>("/api/ai/invoice-ocr", {
        method: "POST",
        body: JSON.stringify({ dataUrl }),
      });

      if (!ok) {
        setError(data.message ?? errorMessage(data.error));
        setBusy(false);
        return;
      }

      setResult(data);
      setSupplierId(data.supplierId ?? "");
      // Guard the picker's ISO contract: a malformed date read off the
      // invoice (or a Shamsi one the model passed through verbatim) must
      // drop to empty rather than poison the date field.
      const invoiceDate = data.extraction?.invoiceDate ?? "";
      setPurchaseDate(/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) ? invoiceDate : "");
      setNote(data.extraction?.note ?? "");

      const reviewed = (data.lines ?? []).map((line) => {
        const rial = line.lineTotalRial != null ? String(line.lineTotalRial) : "";
        const totalCost = rial ? money.formatText(rial, { withUnit: false }) : "";
        return {
          ...line,
          inventoryItemId: line.inventoryItemId ?? "",
          purchaseQty: line.quantity ?? "",
          totalCost,
          include: line.matchStatus === "matched" && Boolean(line.inventoryItemId) && Boolean(line.quantity),
        };
      });
      setLines(reviewed);
    } catch {
      setError("ارتباط با سرویس OCR برقرار نشد.");
    }
    setBusy(false);
  }

  function updateLine(
    key: string,
    patch: Partial<{ inventoryItemId: string; purchaseQty: string; totalCost: string; include: boolean }>,
  ) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function applyToForm() {
    const payloadLines: InvoiceOcrDraftLine[] = lines
      .filter((l) => l.include && l.inventoryItemId && l.purchaseQty.trim())
      .map((l) => ({
        inventoryItemId: l.inventoryItemId,
        purchaseQty: l.purchaseQty.trim(),
        totalCost: l.totalCost.trim(),
        sourceName: l.name,
      }));
    if (payloadLines.length === 0) {
      setError("حداقل یک ردیف متصل‌شده با مقدار را برای انتقال انتخاب کنید.");
      return;
    }
    onApply({
      supplierId,
      purchaseDate,
      note: note.trim(),
      lines: payloadLines,
      invoiceAssetId: result?.asset?.id ?? null,
    });
  }

  const verdict = result?.validation?.verdict;
  const VerdictIcon = verdict ? VERDICT_STYLE[verdict].icon : null;

  return (
    <SectionCard
      title="اسکن فاکتور با هوش مصنوعی"
      description="از فاکتور تأمین‌کننده عکس بگیرید یا فایل را بارگذاری کنید. متن با OCR خوانده می‌شود، اقلام با انبار تطبیق داده می‌شوند و پس از بررسی شما به فرم خرید منتقل می‌گردند."
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void runOcr(file);
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void runOcr(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-12 flex-1"
          disabled={disabled || busy}
          onClick={() => cameraRef.current?.click()}
        >
          <CameraIcon className="size-4" aria-hidden="true" />
          عکس با دوربین
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-12 flex-1"
          disabled={disabled || busy}
          onClick={() => fileRef.current?.click()}
        >
          <FileImageIcon className="size-4" aria-hidden="true" />
          بارگذاری تصویر
        </Button>
        {result ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-12"
            disabled={busy}
            onClick={() => {
              setPreviewUrl(null);
              resetReview();
            }}
          >
            پاک کردن
          </Button>
        ) : null}
      </div>

      {busy ? (
        <LoadingSkeleton
          rows={4}
          compact
          className="mt-3"
          label="در حال خواندن فاکتور با هوش مصنوعی"
        />
      ) : null}

      {error ? (
        <p className="mt-3 rounded-xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-500/15 px-3 py-2 text-xs leading-5 text-rose-800 dark:text-rose-200" role="alert">
          {error}
        </p>
      ) : null}

      {previewUrl && !result && !busy ? (
        <img
          src={previewUrl}
          alt="پیش‌نمایش فاکتور"
          className="mt-3 max-h-48 rounded-xl border border-border object-contain"
        />
      ) : null}

      {result?.validation && VerdictIcon ? (
        <div className={`mt-4 rounded-xl border px-3 py-2.5 text-sm ${VERDICT_STYLE[result.validation.verdict].box}`}>
          <p className="flex items-center gap-2 font-semibold">
            <VerdictIcon className="size-4 shrink-0" aria-hidden="true" />
            {VERDICT_STYLE[result.validation.verdict].label}
            <span className="font-normal">
              — اطمینان کلی {toPersianDigits(Math.round(result.validation.overallConfidence * 100))}٪
            </span>
          </p>
          <p className="mt-1 text-xs leading-5">{result.validation.summary}</p>
          {result.validation.issues.length > 0 ? (
            <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs leading-5">
              {result.validation.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {typeof result.costRial === "number" && result.costRial > 0 ? (
            <p className="mt-2 text-[11px] opacity-80">
              هزینه این اسکن: {money.format(result.costRial)}
            </p>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="mt-4 space-y-3">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="تأمین‌کننده">
              <SearchableSelect value={supplierId} onChange={setSupplierId} options={supplierOptions} />
            </Field>
            <Field label="تاریخ فاکتور">
              <JalaliDatePicker
                value={purchaseDate}
                onChange={setPurchaseDate}
                placeholder="تاریخ فاکتور"
              />
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>

          {result.extraction?.invoiceNumber ? (
            <p className="text-xs text-muted-foreground">
              شماره فاکتور: {toPersianDigits(result.extraction.invoiceNumber)}
              {result.extraction.totalRial != null
                ? ` · جمع کل: ${money.format(result.extraction.totalRial)}`
                : null}
            </p>
          ) : null}

          <ul className="space-y-2">
            {lines.map((line) => {
              const statusLabel =
                line.matchStatus === "matched"
                  ? "متصل"
                  : line.matchStatus === "ambiguous"
                    ? "چند گزینه"
                    : "بدون اتصال";
              const statusClass =
                line.matchStatus === "matched"
                  ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-900 dark:text-emerald-100"
                  : line.matchStatus === "ambiguous"
                    ? "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-950 dark:text-amber-200"
                    : "border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-500/15 text-rose-900 dark:text-rose-100";
              const candidateOptions =
                line.candidates.length > 0
                  ? [
                      { value: "", label: "انتخاب کنید…" },
                      ...line.candidates.map((c) => ({ value: c.id, label: c.name })),
                      ...itemOptions.filter(
                        (o) => o.value && !line.candidates.some((c) => c.id === o.value),
                      ),
                    ]
                  : itemOptions;

              return (
                <li
                  key={line.key}
                  className="rounded-xl border border-border bg-muted/50 p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{line.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {line.barcode ? `بارکد ${toPersianDigits(line.barcode)} · ` : null}
                        {line.confidence != null
                          ? `اطمینان ${toPersianDigits(Math.round(line.confidence * 100))}٪`
                          : "اطمینان نامشخص"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusClass}`}>
                        {statusLabel}
                      </span>
                      <label className="flex items-center gap-1.5 text-xs text-foreground/80">
                        <input
                          type="checkbox"
                          checked={line.include}
                          onChange={(e) => updateLine(line.key, { include: e.target.checked })}
                          className="size-4 rounded border-border"
                        />
                        انتقال
                      </label>
                    </div>
                  </div>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    <Field label="قلم انبار">
                      <SearchableSelect
                        value={line.inventoryItemId}
                        onChange={(value) => updateLine(line.key, { inventoryItemId: value, include: Boolean(value) })}
                        options={candidateOptions}
                      />
                    </Field>
                    <Field label={`مقدار${line.unit ? ` (${line.unit})` : ""}`}>
                      <PersianNumberInput
                        className={inputClass}
                        dir="ltr"
                        inputMode="decimal"
                        allowNegative={false}
                        value={line.purchaseQty}
                        onChange={(e) => updateLine(line.key, { purchaseQty: e.target.value })}
                      />
                    </Field>
                    <Field label={`مبلغ (${money.unitLabel})`}>
                      <PersianNumberInput
                        className={inputClass}
                        dir="ltr"
                        inputMode="numeric"
                        allowNegative={false}
                        value={line.totalCost}
                        onChange={(e) => updateLine(line.key, { totalCost: e.target.value })}
                      />
                    </Field>
                  </div>
                  {line.inventoryItemName && line.matchStatus === "matched" ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      پیشنهاد: {line.inventoryItemName}
                      {line.quantity ? ` · ${formatQuantity(line.quantity)}` : null}
                    </p>
                  ) : null}
                </li>
              );
            })}
            {lines.length === 0 ? (
              <li className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                قلمی از فاکتور استخراج نشد.
              </li>
            ) : null}
          </ul>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              className="min-h-12 sm:min-w-52"
              disabled={disabled || busy || lines.every((l) => !l.include)}
              onClick={applyToForm}
            >
              انتقال به فرم خرید
            </Button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    attachment_invalid: "فرمت یا حجم تصویر فاکتور پشتیبانی نمی‌شود.",
    ai_unavailable: "سرویس هوش مصنوعی هنوز آماده نیست.",
    ai_credit_required: "اعتبار هوش مصنوعی کافی نیست.",
    ai_timeout: "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.",
    ai_network: "اتصال به سرویس هوش مصنوعی برقرار نشد.",
    ai_auth: "پیکربندی سرویس هوش مصنوعی نامعتبر است.",
    extraction_failed: "استخراج اطلاعات از تصویر ممکن نشد.",
    no_location: "شعبه‌ای ثبت نشده است.",
    forbidden: "دسترسی مجاز نیست.",
  };
  return map[code ?? ""] ?? "اسکن فاکتور ناموفق بود.";
}
