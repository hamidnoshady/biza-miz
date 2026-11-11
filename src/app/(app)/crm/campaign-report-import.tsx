"use client";
import { useEffect, useRef, useState } from "react";
import {
  ErrorBox,
  Field,
  inputClass,
  SecondaryButton,
} from "@/app/dashboard/ui";
import {
  CAMPAIGN_IMPORT_FIELDS,
  CAMPAIGN_CSV_MAX_BYTES,
  parseCampaignCsv,
  mapCampaignCsvRow,
  type CampaignCsv,
  type CampaignImportMapping,
} from "@/lib/agency-campaign-report-import";
import type { CampaignReportInput } from "@/lib/agency-campaign-report";

export function CampaignReportImport({
  start,
  end,
  note,
  onPrepared,
}: {
  start: string;
  end: string;
  note: string;
  onPrepared: (report: CampaignReportInput) => void;
}) {
  const [source, setSource] = useState<{
    csv: CampaignCsv;
    name: string;
    hash: string;
  } | null>(null);
  const [mapping, setMapping] = useState<CampaignImportMapping>({}),
    [unit, setUnit] = useState<"" | "rial" | "toman">("");
  const [row, setRow] = useState(0),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<CampaignReportInput | null>(null),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    setPreview(null);
  }, [start, end, note]);
  async function read(file: File | undefined) {
    const id = ++generation.current;
    setSource(null);
    setPreview(null);
    setError("");
    setMapping({});
    setUnit("");
    setRow(0);
    if (!file) {
      setBusy(false);
      return;
    }
    if (file.size > CAMPAIGN_CSV_MAX_BYTES) {
      setError("فایل باید حداکثر یک مگابایت باشد.");
      return;
    }
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const csv = parseCampaignCsv(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (id === generation.current)
        setSource({ csv, name: file.name.slice(0, 255), hash });
    } catch {
      if (id === generation.current)
        setError(
          "CSV معتبر UTF-8 با جداکنندهٔ ویرگول، سرستون یکتا و حداکثر ۱۰۰۰ ردیف لازم است.",
        );
    } finally {
      if (id === generation.current) setBusy(false);
    }
  }
  function prepare() {
    if (!source) return;
    if (!unit) {
      setError("واحد پول فایل را صریحاً انتخاب کنید.");
      return;
    }
    setError("");
    setPreview(null);
    try {
      setPreview(
        mapCampaignCsvRow(source.csv, row, mapping, unit, {
          periodStart: start,
          periodEnd: end,
          attributionNote: note,
          evidenceReference: `CSV ${source.name}; data row ${row + 1}; SHA-256 ${source.hash}`,
        }),
      );
    } catch {
      setError(
        "بازه و روش انتساب را در فرم تکمیل کنید؛ نگاشت یکتا، واحد پول و عدد صحیح بدون جداکننده برای همهٔ مقادیر الزامی لازم است. ستون خالی، صفر نیست.",
      );
    }
  }
  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <p className="text-sm">
        ورود CSV: فایل فقط در مرورگر خوانده می‌شود؛ هر بار یک ردیف برای یک دوره.
        جمع خودکار یا ثبت گروهی انجام نمی‌شود. هش فایل، صحت ادعای منبع یا انتساب
        را تأیید نمی‌کند.
      </p>
      <Field label="فایل گزارش CSV">
        <input
          className={inputClass}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => void read(e.target.files?.[0])}
        />
      </Field>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {source ? (
        <>
          <p className="break-all text-xs" dir="ltr">
            {source.name} — SHA-256 {source.hash}
          </p>
          <Field label="ردیف دادهٔ CSV">
            <select
              className={inputClass}
              value={row}
              onChange={(e) => {
                setRow(Number(e.target.value));
                setPreview(null);
              }}
            >
              {source.csv.rows.map((_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </Field>
          <Field label="واحد پول فایل CSV">
            <select
              className={inputClass}
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value as "rial" | "toman");
                setPreview(null);
              }}
            >
              <option value="">انتخاب واحد پول الزامی</option>
              <option value="rial">ریال</option>
              <option value="toman">تومان (تبدیل دقیق ×۱۰ به ریال)</option>
            </select>
          </Field>
          {CAMPAIGN_IMPORT_FIELDS.map((field) => (
            <Field key={field} label={`ستون ${field}`}>
              <select
                className={inputClass}
                value={mapping[field] ?? ""}
                onChange={(e) => {
                  setMapping((m) => ({ ...m, [field]: e.target.value }));
                  setPreview(null);
                }}
              >
                <option value="">
                  {field === "reach" || field === "revenueRial"
                    ? "نامشخص / بدون ستون"
                    : "انتخاب ستون الزامی"}
                </option>
                {source.csv.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          <SecondaryButton onClick={prepare}>
            پیش‌نمایش ردیف CSV
          </SecondaryButton>
          {preview ? (
            <>
              <pre className="overflow-auto text-xs" dir="ltr">
                {JSON.stringify(preview, null, 2)}
              </pre>
              <SecondaryButton
                onClick={() => {
                  onPrepared(preview);
                  setPreview(null);
                }}
              >
                انتقال پیش‌نمایش به فرم؛ بدون ثبت
              </SecondaryButton>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
