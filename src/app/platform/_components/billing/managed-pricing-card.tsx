"use client";

/**
 * Issue #902 §4 — retail pricing for the managed messaging service.
 *
 * The business pays one number out of its one platform wallet. Behind it sit the
 * provider's wholesale cost (internal, never shown to a tenant), a markup, a
 * handling surcharge, volume tiers, per-business agreements, a promotion
 * window, tax and a monthly free allowance. This card is where Superadmin
 * publishes that policy — versioned, effective-dated and audited — and sees the
 * version in force.
 *
 * Deliberately NOT here: any wholesale tariff, provider name, child balance or
 * margin. Those live on the platform SMS console, because they are platform
 * infrastructure, not a tenant price.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { toLatinDigits } from "@/lib/digits";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { formatRial } from "@/lib/platform-money";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, SkeletonRows, useCan } from "../../ui";

interface Slab {
  minMonthlySegments: number;
  markupBps: number;
  fixedSurchargeRial: number;
}

interface Override {
  scope: "channel" | "business" | "business_channel";
  businessId: string | null;
  channel: "sms" | "email" | null;
  markupBps: number | null;
  fixedSurchargeRial: number | null;
  note?: string | null;
}

interface Version {
  id: string | null;
  version: number;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  markupBps: number;
  fixedSurchargeRial: number;
  discountBps: number;
  discountUntil: string | null;
  taxBps: number;
  freeAllowanceSegments: number;
  failedSendPolicy: "refund" | "charge";
  note: string | null;
  slabs: Slab[];
  overrides: Override[];
}

interface Overview {
  current: Version;
  history: Version[];
  month: { businessesWithUsage: number; segments: number };
}

const CHANNEL_LABELS: Record<"sms" | "email", string> = { sms: "پیامک", email: "ایمیل" };

/** Percent for a human, basis points for the engine. */
function percentToBps(value: string): number | null {
  const parsed = Number(toLatinDigits(value.trim()).replace(/,/g, ""));
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function bpsToPercent(value: number): string {
  return String(Math.round(value) / 100);
}

function jalaliDate(value: string | null): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  } catch {
    return "—";
  }
}

interface SlabDraft {
  min: string;
  markup: string;
  surcharge: string;
}

interface OverrideDraft {
  scope: "channel" | "business" | "business_channel";
  businessId: string;
  businessName: string;
  channel: "sms" | "email";
  markup: string;
  surcharge: string;
}

interface BusinessOption {
  id: string;
  name: string;
}

function BusinessSearch({
  value,
  label,
  onPick,
}: {
  value: string;
  label: string;
  onPick: (business: BusinessOption) => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<BusinessOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const { ok, data } = await api<{ businesses?: BusinessOption[] }>(
        `/api/platform/businesses?search=${encodeURIComponent(term.trim())}&pageSize=8`,
      );
      if (cancelled) return;
      setLoading(false);
      if (ok) setResults((data.businesses ?? []).map((b) => ({ id: b.id, name: b.name })));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLoading(false);
    };
  }, [term]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
        <span className="truncate">{label || "کسب‌وکار انتخاب‌شده"}</span>
        <span className="text-xs text-muted-foreground" dir="ltr">
          {value.slice(0, 8)}…
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <input
        className={inputClass}
        placeholder="جست‌وجوی نام کسب‌وکار…"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
      />
      {loading && <p className="text-xs text-muted-foreground">در حال جست‌وجو…</p>}
      {results.length > 0 && (
        <ul className="max-h-40 overflow-auto rounded-md border text-sm">
          {results.map((business) => (
            <li key={business.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-right hover:bg-muted"
                onClick={() => {
                  onPick(business);
                  setTerm("");
                  setResults([]);
                }}
              >
                {business.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ManagedRetailPricingCard() {
  const canManage = useCan()("billing.manage");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [markup, setMarkup] = useState("0");
  const [surcharge, setSurcharge] = useState("0");
  const [tax, setTax] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [discountUntil, setDiscountUntil] = useState("");
  const [freeAllowance, setFreeAllowance] = useState("0");
  const [failedSendPolicy, setFailedSendPolicy] = useState<"refund" | "charge">("refund");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [note, setNote] = useState("");
  const [slabs, setSlabs] = useState<SlabDraft[]>([]);
  const [overrides, setOverrides] = useState<OverrideDraft[]>([]);

  const load = useCallback(async () => {
    const { ok, data } = await api<Overview & { error?: string }>("/api/platform/billing/retail-pricing");
    if (ok) setOverview(data);
    else setError(data.error ?? "بارگذاری سیاست قیمت‌گذاری ممکن نشد.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function seedFromCurrent() {
    if (!overview) return;
    setMarkup(bpsToPercent(overview.current.markupBps));
    setSurcharge(String(overview.current.fixedSurchargeRial));
    setTax(bpsToPercent(overview.current.taxBps));
    setDiscount(bpsToPercent(overview.current.discountBps));
    setFreeAllowance(String(overview.current.freeAllowanceSegments));
    setFailedSendPolicy(overview.current.failedSendPolicy);
    setSlabs(
      overview.current.slabs.map((slab) => ({
        min: String(slab.minMonthlySegments),
        markup: bpsToPercent(slab.markupBps),
        surcharge: String(slab.fixedSurchargeRial),
      })),
    );
    setOverrides(
      overview.current.overrides.map((row) => ({
        scope: row.scope,
        businessId: row.businessId ?? "",
        businessName: "",
        channel: row.channel ?? "sms",
        markup: row.markupBps === null ? "" : bpsToPercent(row.markupBps),
        surcharge: row.fixedSurchargeRial === null ? "" : String(row.fixedSurchargeRial),
      })),
    );
    setInfo("مقادیر نسخهٔ جاری در فرم بارگذاری شد؛ ویرایش کنید و نسخهٔ جدید را منتشر کنید.");
  }

  async function publish(event: FormEvent) {
    event.preventDefault();
    setError("");
    setInfo("");

    const markupBps = percentToBps(markup);
    const taxBps = percentToBps(tax);
    const discountBps = percentToBps(discount);
    const surchargeRial = Number(toLatinDigits(surcharge));
    const freeSegments = Number(toLatinDigits(freeAllowance));
    if (markupBps === null || taxBps === null || discountBps === null) {
      setError("درصدها باید اعداد صفر یا بزرگ‌تر باشند.");
      return;
    }
    if (!Number.isSafeInteger(surchargeRial) || surchargeRial < 0 || !Number.isSafeInteger(freeSegments) || freeSegments < 0) {
      setError("مبلغ سربار و سهمیهٔ رایگان باید اعداد صحیح صفر یا بزرگ‌تر باشند.");
      return;
    }

    const slabPayload = [];
    for (const slab of slabs) {
      const min = Number(toLatinDigits(slab.min));
      const slabMarkup = percentToBps(slab.markup);
      const slabSurcharge = Number(toLatinDigits(slab.surcharge || "0"));
      if (!Number.isSafeInteger(min) || min < 0 || slabMarkup === null || !Number.isSafeInteger(slabSurcharge) || slabSurcharge < 0) {
        setError("پلهٔ حجمی نامعتبر است: حداقل قطعه، درصد و سربار باید عدد صحیح نامنفی باشند.");
        return;
      }
      slabPayload.push({ minMonthlySegments: min, markupBps: slabMarkup, fixedSurchargeRial: slabSurcharge });
    }

    const overridePayload = [];
    for (const row of overrides) {
      if (row.scope !== "channel" && !row.businessId) {
        setError("برای استثنای کسب‌وکار، ابتدا کسب‌وکار را انتخاب کنید.");
        return;
      }
      const rowMarkup = row.markup.trim() === "" ? null : percentToBps(row.markup);
      const rowSurcharge = row.surcharge.trim() === "" ? null : Number(toLatinDigits(row.surcharge));
      if (rowMarkup === null && rowSurcharge === null) {
        setError("هر استثنا باید دست‌کم درصد یا سربار داشته باشد.");
        return;
      }
      overridePayload.push({
        scope: row.scope,
        businessId: row.scope === "channel" ? null : row.businessId,
        channel: row.scope === "business" ? null : row.channel,
        markupBps: rowMarkup,
        fixedSurchargeRial: rowSurcharge,
      });
    }

    setBusy(true);
    const { ok, data } = await api<{ version?: Version; error?: string }>("/api/platform/billing/retail-pricing", {
      method: "POST",
      body: JSON.stringify({
        markupBps,
        fixedSurchargeRial: surchargeRial,
        taxBps,
        discountBps,
        discountUntil: discountUntil || null,
        freeAllowanceSegments: freeSegments,
        failedSendPolicy,
        effectiveFrom: effectiveFrom || null,
        note: note || null,
        slabs: slabPayload,
        overrides: overridePayload,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(
        data.error === "effective_from_before_current"
          ? "زمان اجرا نمی‌تواند پیش از شروع نسخهٔ جاری باشد."
          : data.error === "invalid_markup" || data.error === "invalid_tax" || data.error === "invalid_discount"
            ? "درصدها باید بین ۰ تا ۱۰۰ باشند."
            : "انتشار نسخهٔ قیمت انجام نشد.",
      );
      return;
    }
    setInfo(`نسخهٔ ${data.version?.version ?? ""} قیمت‌گذاری منتشر شد و در سابقهٔ حسابرسی ثبت شد.`);
    setDiscountUntil("");
    setEffectiveFrom("");
    setNote("");
    await load();
  }

  if (!overview) {
    return (
      <Card title="قیمت‌گذاری خرده‌فروشی پیام مدیریت‌شده">
        {error ? <ErrorBox>{error}</ErrorBox> : <SkeletonRows rows={4} />}
      </Card>
    );
  }

  const current = overview.current;
  const isDefault = current.version === 0;

  return (
    <Card title="قیمت‌گذاری خرده‌فروشی پیام مدیریت‌شده">
      <p className="mb-3 text-xs text-muted-foreground">
        کسب‌وکار فقط «هزینهٔ ارسال» را از کیف پول پلتفرم می‌پردازد؛ تعرفهٔ تأمین‌کننده، سود و اعتبار حساب‌های داخلی هرگز به کسب‌وکار نشان داده نمی‌شود.
        هر نسخه زمان اجرا دارد و پرداخت‌ها با نسخهٔ دارای اعتبار در لحظهٔ رزرو محاسبه می‌شوند.
      </p>

      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <div className="mb-4 grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          نسخهٔ جاری: <span className="font-medium">{isDefault ? "پایه (بدون حاشیه)" : current.version}</span>
        </div>
        <div>اجرا از: {jalaliDate(current.effectiveFrom)}</div>
        <div>حاشیهٔ سود: {bpsToPercent(current.markupBps)}٪</div>
        <div>سربار ثابت هر پیام: {formatRial(current.fixedSurchargeRial)}</div>
        <div>مالیات/عوارض: {bpsToPercent(current.taxBps)}٪</div>
        <div>تخفیف: {bpsToPercent(current.discountBps)}٪ {current.discountUntil ? `تا ${jalaliDate(current.discountUntil)}` : ""}</div>
        <div>سهمیهٔ رایگان ماهانه: {current.freeAllowanceSegments.toLocaleString("fa-IR")} قطعه</div>
        <div>
          رویهٔ ارسال ناموفق: {current.failedSendPolicy === "refund" ? "بازگشت کامل اعتبار" : "محاسبهٔ همان تلاش"}
        </div>
        <div>
          ماه جاری: {overview.month.businessesWithUsage.toLocaleString("fa-IR")} کسب‌وکار،{" "}
          {overview.month.segments.toLocaleString("fa-IR")} قطعه
        </div>
        {(current.slabs.length > 0 || current.overrides.length > 0) && (
          <div className="sm:col-span-2 lg:col-span-3 text-xs text-muted-foreground">
            {current.slabs.length > 0 && `پله‌های حجمی: ${current.slabs.length.toLocaleString("fa-IR")} — `}
            {current.overrides.length > 0 && `استثناها: ${current.overrides.length.toLocaleString("fa-IR")}`}
          </div>
        )}
      </div>

      <form onSubmit={publish} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="حاشیهٔ سود (٪)">
            <PersianNumberInput className={inputClass} inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="سربار ثابت هر پیام (ریال)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={surcharge} onChange={(e) => setSurcharge(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="مالیات/عوارض (٪)">
            <PersianNumberInput className={inputClass} inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="سهمیهٔ رایگان ماهانه (قطعه)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={freeAllowance} onChange={(e) => setFreeAllowance(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="تخفیف/کمپین (٪)">
            <PersianNumberInput className={inputClass} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="پایان تخفیف (اختیاری)">
            <input type="datetime-local" className={inputClass} value={discountUntil} onChange={(e) => setDiscountUntil(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="زمان اجرا (اختیاری)">
            <input type="datetime-local" className={inputClass} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="رویهٔ ارسال ناموفق">
            <select
              className={inputClass}
              value={failedSendPolicy}
              onChange={(e) => setFailedSendPolicy(e.target.value === "charge" ? "charge" : "refund")}
              disabled={!canManage}
            >
              <option value="refund">بازگشت کامل اعتبار (پیش‌فرض)</option>
              <option value="charge">محاسبهٔ تلاش ارسال</option>
            </select>
          </Field>
        </div>

        <Field label="یادداشت تغییر">
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canManage} maxLength={500} />
        </Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">پله‌های حجمی (بر پایهٔ قطعه در ماه جاری)</h4>
            <Button type="button" variant="ghost" disabled={!canManage} onClick={() => setSlabs([...slabs, { min: "", markup: bpsToPercent(current.markupBps), surcharge: "0" }])}>
              <PlusIcon className="size-4" /> افزودن پله
            </Button>
          </div>
          {slabs.length === 0 && <p className="text-xs text-muted-foreground">بدون پله؛ همهٔ کسب‌وکارها با همین درصد و سربار محاسبه می‌شوند.</p>}
          {slabs.map((slab, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-4">
              <input
                className={inputClass}
                placeholder="از چند قطعه"
                value={slab.min}
                disabled={!canManage}
                onChange={(e) => setSlabs(slabs.map((row, i) => (i === index ? { ...row, min: e.target.value } : row)))}
              />
              <input
                className={inputClass}
                placeholder="حاشیه (٪)"
                value={slab.markup}
                disabled={!canManage}
                onChange={(e) => setSlabs(slabs.map((row, i) => (i === index ? { ...row, markup: e.target.value } : row)))}
              />
              <input
                className={inputClass}
                placeholder="سربار (ریال)"
                value={slab.surcharge}
                disabled={!canManage}
                onChange={(e) => setSlabs(slabs.map((row, i) => (i === index ? { ...row, surcharge: e.target.value } : row)))}
              />
              <Button type="button" variant="danger" disabled={!canManage} onClick={() => setSlabs(slabs.filter((_, i) => i !== index))}>
                <Trash2Icon className="size-4" /> حذف
              </Button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">استثناها (کانال یا کسب‌وکار خاص)</h4>
            <Button
              type="button"
              variant="ghost"
              disabled={!canManage}
              onClick={() =>
                setOverrides([
                  ...overrides,
                  { scope: "channel", businessId: "", businessName: "", channel: "sms", markup: "", surcharge: "" },
                ])
              }
            >
              <PlusIcon className="size-4" /> افزودن استثنا
            </Button>
          </div>
          {overrides.length === 0 && <p className="text-xs text-muted-foreground">بدون استثنا؛ یک قیمت برای همه.</p>}
          {overrides.map((row, index) => (
            <div key={index} className="space-y-2 rounded-md border p-2">
              <div className="grid gap-2 sm:grid-cols-4">
                <select
                  className={inputClass}
                  value={row.scope}
                  disabled={!canManage}
                  onChange={(e) =>
                    setOverrides(
                      overrides.map((item, i) =>
                        i === index ? { ...item, scope: e.target.value as OverrideDraft["scope"] } : item,
                      ),
                    )
                  }
                >
                  <option value="channel">یک کانال</option>
                  <option value="business">یک کسب‌وکار</option>
                  <option value="business_channel">کسب‌وکار + کانال</option>
                </select>
                <select
                  className={inputClass}
                  value={row.channel}
                  disabled={!canManage || row.scope === "business"}
                  onChange={(e) =>
                    setOverrides(
                      overrides.map((item, i) => (i === index ? { ...item, channel: e.target.value as "sms" | "email" } : item)),
                    )
                  }
                >
                  <option value="sms">{CHANNEL_LABELS.sms}</option>
                  <option value="email">{CHANNEL_LABELS.email}</option>
                </select>
                <input
                  className={inputClass}
                  placeholder="حاشیه (٪)"
                  value={row.markup}
                  disabled={!canManage}
                  onChange={(e) => setOverrides(overrides.map((item, i) => (i === index ? { ...item, markup: e.target.value } : item)))}
                />
                <input
                  className={inputClass}
                  placeholder="سربار (ریال)"
                  value={row.surcharge}
                  disabled={!canManage}
                  onChange={(e) => setOverrides(overrides.map((item, i) => (i === index ? { ...item, surcharge: e.target.value } : item)))}
                />
              </div>
              {row.scope !== "channel" && (
                <BusinessSearch
                  value={row.businessId}
                  label={row.businessName}
                  onPick={(business) =>
                    setOverrides(
                      overrides.map((item, i) => (i === index ? { ...item, businessId: business.id, businessName: business.name } : item)),
                    )
                  }
                />
              )}
              <Button type="button" variant="danger" disabled={!canManage} onClick={() => setOverrides(overrides.filter((_, i) => i !== index))}>
                <Trash2Icon className="size-4" /> حذف استثنا
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canManage || busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null} انتشار نسخهٔ جدید قیمت
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={seedFromCurrent}>
            بارگذاری مقادیر نسخهٔ جاری
          </Button>
          {!canManage && <span className="text-xs text-muted-foreground">برای انتشار نسخه، دسترسی «مدیریت مالی» لازم است.</span>}
        </div>
      </form>

      <div className="mt-4 space-y-2">
        <h4 className="text-sm font-medium">سابقهٔ نسخه‌ها</h4>
        {overview.history.length === 0 ? (
          <p className="text-xs text-muted-foreground">هنوز نسخه‌ای منتشر نشده است.</p>
        ) : (
          <ul className="divide-y rounded-md border text-xs">
            {overview.history.map((row) => (
              <li key={row.id ?? `v${row.version}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="font-medium">نسخهٔ {row.version}</span>
                <span>{jalaliDate(row.effectiveFrom)}</span>
                <span>حاشیه {bpsToPercent(row.markupBps)}٪</span>
                <span>مالیات {bpsToPercent(row.taxBps)}٪</span>
                <span className="text-muted-foreground">{row.note || "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
