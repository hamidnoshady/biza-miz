"use client";

/**
 * Phase 42 — «الگوی بارکد وزنی»: the reference's pattern screen on the
 * platform chrome. Each pattern is a fixed two-digit prefix plus the unit its
 * five weight digits are measured in; the preview renders the specimen label
 * (PP / RRRRR / WWWWW / C) with a live-computed EAN-13 check digit
 * (weight-barcode.ts). Existing patterns can be removed; «افزودن الگو» opens
 * a draft card and «ثبت الگو» saves the drafts.
 */
import { useEffect, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import {
  formatBarcodeHumanReadable,
  sampleWeightBarcode,
  WEIGHT_UNIT_LABELS,
  type WeightUnit,
} from "@/lib/weight-barcode";
import type { WeightBarcodeTemplate } from "@/lib/weight-barcode-templates-service";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { cardClass, EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";

interface DraftTemplate {
  key: number;
  prefix: string;
  weightUnit: WeightUnit;
}

const PREFIX_OPTIONS = ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"];

export function BarcodeTemplatesSection() {
  const [templates, setTemplates] = useState<WeightBarcodeTemplate[] | null>(null);
  const [drafts, setDrafts] = useState<DraftTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => {
    api<{ templates: WeightBarcodeTemplate[] }>("/api/products/barcode-templates").then(({ ok, data }) => {
      if (ok) setTemplates(data.templates);
    });
  };
  useEffect(load, []);

  const previewSource = drafts[0]
    ? { prefix: drafts[0].prefix, weightUnit: drafts[0].weightUnit }
    : templates?.[0]
      ? { prefix: templates[0].prefix, weightUnit: templates[0].weightUnit }
      : { prefix: "20", weightUnit: "grams" as WeightUnit };
  const sample = sampleWeightBarcode(previewSource.prefix, previewSource.weightUnit);

  async function saveDrafts() {
    if (drafts.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    let failed = false;
    for (const draft of drafts) {
      const { ok, data } = await api("/api/products/barcode-templates", {
        method: "POST",
        body: JSON.stringify({ prefix: draft.prefix, weightUnit: draft.weightUnit }),
      });
      if (!ok) {
        failed = true;
        setError(data.error === "duplicate_prefix" ? `پیش‌شمارهٔ ${toPersianDigits(draft.prefix)} قبلاً ثبت شده است.` : "ثبت نشد؛ دوباره تلاش کنید.");
      }
    }
    setBusy(false);
    if (failed) return;
    setDrafts([]);
    setNotice("الگوها ثبت شد.");
    load();
  }

  async function remove(template: WeightBarcodeTemplate) {
    setError("");
    const { ok } = await api(`/api/products/barcode-templates/${template.id}`, { method: "DELETE" });
    if (!ok) setError("حذف نشد؛ دوباره تلاش کنید.");
    load();
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <div data-tour-id="barcode-templates.preview">
      <SectionCard title="پیش‌نمایش برچسب" description="نمونهٔ زندهٔ الگوی فعال: پیش‌شماره، کد کالا، مقدار وزن و رقم کنترل.">
        <div className="grid min-w-0 items-center gap-6 lg:grid-cols-2">
          <div className="flex flex-col items-center gap-2 rounded-xl bg-muted/40 p-6">
            <BarcodeArt code={sample} />
            <p className="text-xs text-muted-foreground" dir="ltr">
              {formatBarcodeHumanReadable(sample)}
            </p>
          </div>
          <ul className="min-w-0 space-y-2">
            <SegmentRow label="پیش‌شماره (Prefix)" value={sample.slice(0, 2)} />
            <SegmentRow label="کد کالا (Item Reference)" value={sample.slice(2, 7)} />
            <SegmentRow label="مقدار وزن (Weight Value)" value={sample.slice(7, 12)} />
            <SegmentRow label="رقم کنترل (Check Digit)" value={sample.slice(12)} />
          </ul>
        </div>
      </SectionCard>
      </div>

      {templates === null ? <SectionCardSkeleton rows={3} /> : null}

      <div data-tour-id="barcode-templates.list" className="grid min-w-0 gap-4 xl:grid-cols-2">
        {(templates ?? []).map((template, index) => (
          <section key={template.id} className={`${cardClass} min-w-0 p-4 sm:p-5`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-foreground">الگوی شمارهٔ {toPersianDigits(index + 1)}</h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 p-0 text-rose-600 dark:text-rose-400"
                aria-label={`حذف الگوی ${toPersianDigits(index + 1)}`}
                disabled={busy}
                onClick={() => remove(template)}
              >
                <Trash2Icon aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="پیش شماره (کد ثابت الگو)">
                <select className={inputClass} value={template.prefix} disabled>
                  <option value={template.prefix}>{toPersianDigits(template.prefix)}</option>
                </select>
              </Field>
              <Field label="واحد سنجش وزن">
                <select className={inputClass} value={template.weightUnit} disabled>
                  <option value={template.weightUnit}>{WEIGHT_UNIT_LABELS[template.weightUnit]}</option>
                </select>
              </Field>
            </div>
            <p className="mt-3 text-xs text-muted-foreground" dir="ltr">
              {formatBarcodeHumanReadable(sampleWeightBarcode(template.prefix, template.weightUnit))}
            </p>
          </section>
        ))}

        {drafts.map((draft, index) => (
          <section key={draft.key} className={`${cardClass} min-w-0 border-dashed p-4 sm:p-5`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-foreground">
                الگوی شمارهٔ {toPersianDigits((templates?.length ?? 0) + index + 1)} (جدید)
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-8 p-0 text-rose-600 dark:text-rose-400"
                aria-label="حذف پیش‌نویس الگو"
                onClick={() => setDrafts((current) => current.filter((d) => d.key !== draft.key))}
              >
                <Trash2Icon aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="پیش شماره (کد ثابت الگو)">
                <select
                  className={inputClass}
                  value={draft.prefix}
                  onChange={(event) =>
                    setDrafts((current) =>
                      current.map((d) => (d.key === draft.key ? { ...d, prefix: event.target.value } : d)),
                    )
                  }
                >
                  {PREFIX_OPTIONS.map((prefix) => (
                    <option key={prefix} value={prefix}>
                      {toPersianDigits(prefix)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="واحد سنجش وزن">
                <select
                  className={inputClass}
                  value={draft.weightUnit}
                  onChange={(event) =>
                    setDrafts((current) =>
                      current.map((d) =>
                        d.key === draft.key ? { ...d, weightUnit: event.target.value as WeightUnit } : d,
                      ),
                    )
                  }
                >
                  {(Object.keys(WEIGHT_UNIT_LABELS) as WeightUnit[]).map((unit) => (
                    <option key={unit} value={unit}>
                      {WEIGHT_UNIT_LABELS[unit]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="mt-3 text-xs text-muted-foreground" dir="ltr">
              {formatBarcodeHumanReadable(sampleWeightBarcode(draft.prefix, draft.weightUnit))}
            </p>
          </section>
        ))}
      </div>

      {templates !== null && templates.length === 0 && drafts.length === 0 ? (
        <EmptyState>الگویی ثبت نشده؛ با «افزودن الگو» اولین الگوی بارکد وزنی را بسازید.</EmptyState>
      ) : null}

      <button
        type="button"
        data-tour-id="barcode-templates.add"
        onClick={() =>
          setDrafts((current) => [
            ...current,
            { key: Date.now(), prefix: PREFIX_OPTIONS[current.length % PREFIX_OPTIONS.length] ?? "20", weightUnit: "grams" },
          ])
        }
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border text-sm font-medium text-foreground/70 transition-colors hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300"
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن الگو
      </button>

      <Button type="button" data-tour-id="barcode-templates.save" size="lg" className="w-full font-semibold" disabled={busy || drafts.length === 0} onClick={saveDrafts}>
        ثبت الگو
      </Button>
      {notice ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p> : null}
    </div>
  );
}

function SegmentRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2">
      <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
      <span className="shrink-0 rounded-xl bg-amber-100 dark:bg-amber-500/20 px-3 py-1 font-mono text-xs font-semibold text-amber-950 dark:text-amber-200" dir="ltr">
        {value}
      </span>
    </li>
  );
}

/** A stylised EAN-13 bar pattern — decorative; the digits below carry the data. */
function BarcodeArt({ code }: { code: string }) {
  const bars: { x: number; width: number }[] = [];
  let x = 0;
  for (const char of code) {
    const digit = char.charCodeAt(0) - 48;
    bars.push({ x, width: (digit % 3) + 1 });
    x += (digit % 3) + 2;
    bars.push({ x, width: ((digit >> 1) % 2) + 1 });
    x += ((digit >> 1) % 2) + 3;
  }
  return (
    <svg viewBox={`0 0 ${x} 40`} className="h-16 w-48 text-foreground" aria-hidden="true">
      {bars.map((bar, index) => (
        <rect key={index} x={bar.x} y={0} width={bar.width} height={40} fill="currentColor" />
      ))}
    </svg>
  );
}
