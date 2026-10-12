"use client";

/**
 * Structured rendering of CMS health payloads (audit F18).
 *
 * The CMS returns `saasOverview` / `billingHealth` as opaque objects whose
 * schema belongs to the website platform. Rendering them as raw JSON in a
 * primary card hid the operational state behind punctuation. This view walks
 * the payload and renders scalars as labelled rows — timestamps as Jalali,
 * numbers in Persian digits, booleans as بله/خیر — with nested objects as
 * grouped sections. The sanitized raw payload stays one disclosure away.
 */
import { formatJalali } from "@/lib/jalali";
import { formatPersianNumber } from "@/lib/digits";

const KEY_LABELS: Record<string, string> = {
  status: "وضعیت",
  state: "وضعیت",
  ok: "سالم",
  healthy: "سالم",
  lastSuccessAt: "آخرین موفقیت",
  lastErrorAt: "آخرین خطا",
  lastError: "آخرین خطا",
  lastRunAt: "آخرین اجرا",
  generatedAt: "زمان تولید گزارش",
  updatedAt: "آخرین به‌روزرسانی",
  backlog: "صف انتظار",
  backlogCount: "تعداد صف انتظار",
  oldestPendingAt: "قدیمی‌ترین مورد در صف",
  queued: "در صف",
  pending: "در انتظار",
  failed: "ناموفق",
  processed: "پردازش‌شده",
  credentialsReady: "آمادگی اعتبارنامه",
  credentialReady: "آمادگی اعتبارنامه",
  projectionState: "وضعیت پروجکشن",
  projectionAt: "زمان پروجکشن",
  count: "تعداد",
  total: "جمع",
  revenueRial: "درآمد (ریال)",
  mrrRial: "درآمد ماهانه (ریال)",
  activeSites: "سایت‌های فعال",
  activeSubscriptions: "اشتراک‌های فعال",
  openInvoices: "صورتحساب‌های باز",
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function structuredValueText(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "بله" : "خیر";
  if (typeof value === "number") {
    return /rial/i.test(key) ? `${formatPersianNumber(value)} ریال` : formatPersianNumber(value);
  }
  if (typeof value === "string") {
    if (ISO_RE.test(value)) return formatJalali(value, { withTime: true });
    return value;
  }
  if (Array.isArray(value)) return `${formatPersianNumber(value.length)} مورد`;
  return "—";
}

function labelFor(key: string): string {
  return KEY_LABELS[key] ?? key;
}

type Row = { key: string; label: string; text: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function Rows({ data, prefix = "" }: { data: Record<string, unknown>; prefix?: string }) {
  const scalars: Row[] = [];
  const nested: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value)) nested.push({ key, value });
    else scalars.push({ key, label: labelFor(key), text: structuredValueText(key, value) });
  }
  return (
    <div className="space-y-3">
      {scalars.length ? (
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
          {scalars.map((row) => (
            <div key={prefix + row.key} className="flex justify-between gap-2 border-b border-border/50 pb-1">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-medium tabular-nums text-end" dir={/^[\x00-\x7F]+$/.test(row.text) ? "ltr" : undefined}>
                {row.text}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {nested.map((group) => (
        <div key={prefix + group.key}>
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">{labelFor(group.key)}</h4>
          <div className="ps-3">
            <Rows data={group.value} prefix={`${prefix}${group.key}.`} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Structured health view with the sanitized raw payload behind a disclosure. */
export function StructuredHealth({ data, emptyText = "داده‌ای برای نمایش نیست." }: { data: Record<string, unknown> | null | undefined; emptyText?: string }) {
  if (!data || Object.keys(data).length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="space-y-3">
      <Rows data={data} />
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">داده‌ی خام (تشخیصی)</summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-2" dir="ltr">
          {JSON.stringify(data, null, 2)}
        </pre>
      </details>
    </div>
  );
}
