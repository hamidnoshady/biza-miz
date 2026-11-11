"use client";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import type { CampaignReport } from "@/lib/agency-campaign-report-service";

/** Separate period evidence, never a sum of overlapping snapshots or ledger facts. */
export function CampaignReports({ campaignId }: { campaignId: string }) {
  const money = useMoney();
  const [rows, setRows] = useState<CampaignReport[] | null>(null),
    [canWrite, setCanWrite] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [reference, setReference] = useState("");
  const [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [json, setJson] = useState("");
  const [supersedes, setSupersedes] = useState<string | null>(null);
  const url = `/api/crm/client-campaigns/${campaignId}/reports`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<{
        reports: CampaignReport[];
        canWrite: boolean;
        error?: string;
      }>(url, { signal });
      if (result.aborted || signal?.aborted) return;
      if (!result.ok) {
        setError("خواندن گزارش ممکن نشد؛ دسترسی مشتری و پروژه را بررسی کنید.");
        return;
      }
      setRows(result.data.reports);
      setCanWrite(result.data.canWrite);
      setError("");
    },
    [url],
  );
  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);
  async function save() {
    setError("");
    let measurements: unknown;
    try {
      measurements = JSON.parse(json);
    } catch {
      setError("داده‌های اندازه‌گیری باید یک شیء JSON معتبر باشند.");
      return;
    }
    if (
      !measurements ||
      typeof measurements !== "object" ||
      Array.isArray(measurements)
    ) {
      setError("یک شیء JSON وارد کنید.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ error?: string }>(url, {
        method: "POST",
        body: JSON.stringify({
          ...measurements,
          periodStart: start,
          periodEnd: end,
          evidenceReference: reference,
          attributionNote: note,
          attributionConfirmed: confirmed,
          supersedesId: supersedes,
        }),
      });
      if (!result.ok) {
        setError(
          "گزارش ثبت نشد؛ بازه، منبع، مجوز و نسخهٔ قبلی را بررسی کنید. دورهٔ تکراری باید با اصلاحیه ثبت شود.",
        );
        return;
      }
      setSupersedes(null);
      setJson("");
      setConfirmed(false);
      await load();
    } finally {
      setBusy(false);
    }
  }
  if (rows === null && !error) return <SectionCardSkeleton />;
  return (
    <SectionCard title="گزارش دوره‌ای کمپین کارفرما">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          ورود دستی یا چسباندن دادهٔ خروجی منبع؛ اتصال تبلیغاتی خودکار نیست. این
          ارقام سند حسابداری یا بازاریابی داخلی آژانس نیستند. دوره‌های همپوشان
          با هم جمع نمی‌شوند. حداکثر ۱۰۰ نسخهٔ اخیر نمایش داده می‌شود.
        </p>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <SecondaryButton onClick={() => void load()}>
          تازه‌کردن گزارش‌ها
        </SecondaryButton>
        {(rows ?? []).map((r) => (
          <article
            key={r.id}
            className="space-y-2 rounded-xl border border-border p-3"
          >
            <p className="font-medium">
              {formatJalali(r.periodStart)} تا {formatJalali(r.periodEnd)} —{" "}
              {r.superseded ? "نسخهٔ جایگزین‌شده" : "نسخهٔ جاری این دوره"}
            </p>
            <p className="text-xs">
              منبع: {r.evidenceReference} — ثبت‌کننده: {r.createdByName} —{" "}
              {formatJalali(r.createdAt)}
            </p>
            <p className="text-sm whitespace-pre-wrap">{r.attributionNote}</p>
            <p className="text-xs">
              {r.attributionConfirmed
                ? "انتساب با تصریح دستی ثبت‌کننده؛ نه تأیید پلتفرم"
                : "انتساب نامطمئن؛ CPL، CPA و ROAS گزارش نمی‌شوند"}
            </p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt>هزینهٔ این دوره</dt>
                <dd>{money.format(r.spendRial)}</dd>
              </div>
              <div>
                <dt>بودجهٔ کل کمپین در زمان ثبت (نه بودجهٔ دوره)</dt>
                <dd>
                  {r.campaignBudgetRial === null
                    ? "—"
                    : money.format(r.campaignBudgetRial)}
                </dd>
              </div>
              <div>
                <dt>دسترسی یکتا (Reach)</dt>
                <dd>{r.reach === null ? "—" : toPersianDigits(r.reach)}</dd>
              </div>
              <div>
                <dt>نمایش / کلیک</dt>
                <dd>{toPersianDigits(`${r.impressions} / ${r.clicks}`)}</dd>
              </div>
              <div>
                <dt>سرنخ / تبدیل</dt>
                <dd>
                  {toPersianDigits(`${r.leadsGenerated} / ${r.conversions}`)}
                </dd>
              </div>
              <div>
                <dt>CPL / CPA</dt>
                <dd>
                  {r.metrics.cplRial === null
                    ? "—"
                    : money.format(r.metrics.cplRial)}{" "}
                  /{" "}
                  {r.metrics.cpaRial === null
                    ? "—"
                    : money.format(r.metrics.cpaRial)}
                </dd>
              </div>
              <div>
                <dt>ROAS</dt>
                <dd>
                  {r.metrics.roas === null
                    ? "—"
                    : toPersianDigits(r.metrics.roas)}
                </dd>
              </div>
              <div>
                <dt>درآمد منتسب (نه درآمد دفتر کل)</dt>
                <dd>
                  {r.revenueRial === null ? "—" : money.format(r.revenueRial)}
                </dd>
              </div>
            </dl>
            <a
              className="text-sm text-primary underline"
              download={`campaign-report-${r.id}.json`}
              href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ campaignId, ...r }, null, 2))}`}
            >
              دریافت نسخهٔ JSON همین گزارش
            </a>
            {canWrite && !r.superseded ? (
              <SecondaryButton
                onClick={() => {
                  setSupersedes(r.id);
                  setStart(r.periodStart);
                  setEnd(r.periodEnd);
                  setReference(r.evidenceReference);
                  setNote(r.attributionNote);
                  setConfirmed(false);
                  setJson(
                    JSON.stringify(
                      {
                        spendRial: r.spendRial,
                        reach: r.reach,
                        impressions: r.impressions,
                        clicks: r.clicks,
                        leadsGenerated: r.leadsGenerated,
                        conversions: r.conversions,
                        revenueRial: r.revenueRial,
                      },
                      null,
                      2,
                    ),
                  );
                }}
              >
                اصلاح همین دوره با حفظ نسخهٔ قبلی
              </SecondaryButton>
            ) : null}
          </article>
        ))}
        {canWrite ? (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <p>
              {supersedes
                ? "ثبت اصلاحیه؛ نسخهٔ قبلی حذف نمی‌شود"
                : "گزارش جدید از اندازه‌گیری‌های واقعی"}
            </p>
            <Field label="آغاز دورهٔ گزارش" as="div">
              <JalaliDatePicker
                ariaLabel="آغاز دورهٔ گزارش"
                value={start}
                onChange={setStart}
                disabled={Boolean(supersedes)}
              />
            </Field>
            <Field label="پایان دورهٔ گزارش" as="div">
              <JalaliDatePicker
                ariaLabel="پایان دورهٔ گزارش"
                value={end}
                onChange={setEnd}
                disabled={Boolean(supersedes)}
              />
            </Field>
            <Field label="شناسهٔ منبع یا فایل خروجی">
              <input
                className={inputClass}
                value={reference}
                maxLength={500}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <Field label="روش انتساب، محدودیت و تطبیق منبع">
              <textarea
                className={inputClass}
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <Field
              label="دادهٔ اندازه‌گیری JSON — پول فقط به ریال"
              hint="spendRial، impressions، clicks، leadsGenerated، conversions الزامی‌اند؛ reach و revenueRial می‌توانند null باشند. هیچ عددی پیش‌فرض گرفته نمی‌شود."
            >
              <textarea
                className={`${inputClass} min-h-36`}
                dir="ltr"
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
            </Field>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              انتساب سرنخ، تبدیل و درآمد را با منبع این دوره تطبیق داده‌ام
              (تصریح دستی)
            </label>
            <PrimaryButton
              type="button"
              disabled={
                busy ||
                !start ||
                !end ||
                !reference.trim() ||
                !note.trim() ||
                !json.trim()
              }
              onClick={() => void save()}
            >
              ثبت نسخهٔ غیرقابل‌ویرایش گزارش
            </PrimaryButton>
            {supersedes ? (
              <SecondaryButton
                onClick={() => {
                  setSupersedes(null);
                  setJson("");
                  setConfirmed(false);
                }}
              >
                انصراف از اصلاحیه
              </SecondaryButton>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            ثبت گزارش به مجوز مدیریت مشتری و در پروژهٔ متصل به مدیریت همان پروژه
            نیاز دارد؛ کمپین باید تاریخ آغاز داشته و از وضعیت برنامه‌ریزی خارج
            شده باشد.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
