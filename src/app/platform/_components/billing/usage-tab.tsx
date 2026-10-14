"use client";

/**
 * تعرفه مصرف و اعتبار — the ONE commercial catalogue for metered charges and
 * credit products (§17): AI costing, Messaging per-segment/per-send rates and
 * packages, and the Media/storage daily tariff. Each item shows the unit, the
 * price, the free quota and its active state; wallet top-up packages live
 * here too. The app consoles (/platform/ai, /platform/messaging,
 * /platform/media) only display these values read-only.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Loader2Icon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { toLatinDigits } from "@/lib/digits";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { tomanLabel, formatRial, parseSafeIntInput } from "@/lib/platform-money";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  SkeletonRows,
  useCan,
} from "../../ui";

interface RatesData {
  messaging: { rate: { smsRialPerSegment: number; emailRialPerSend: number } };
  media: {
    billingEnabled: boolean;
    dailyFlatRial: number;
    dailyPerGbRial: number;
    freeQuotaMb: number;
    enhancePriceRial: number;
  };
  ai: {
    usdRialRate: number | null;
    gatewayCostingEnabled: boolean;
    inputCostRialPerMillion: number;
    outputCostRialPerMillion: number;
    revenueMarginPercent: number;
    maxTurnRial: number;
  };
}

interface Pkg {
  id: string;
  name: string;
  priceRial: number;
  creditRial: number;
  isActive: boolean;
  sortOrder: number;
}
interface MessagePkg {
  id: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive: boolean;
  sortOrder: number;
}

export function BillingUsageTab() {
  const canManage = useCan()("billing.manage");
  const [rates, setRates] = useState<RatesData | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [messagePackages, setMessagePackages] = useState<MessagePkg[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ratesRes, pkgRes] = await Promise.all([
      api<RatesData & { error?: string }>("/api/platform/billing/rates"),
      api<{ packages: Pkg[]; messagePackages: MessagePkg[]; error?: string }>(
        "/api/platform/billing/packages",
      ),
    ]);
    if (ratesRes.ok) setRates(ratesRes.data);
    else setError(ratesRes.data.error ?? "بارگذاری تعرفه‌ها ممکن نشد.");
    if (pkgRes.ok) {
      setPackages(pkgRes.data.packages ?? []);
      setMessagePackages(pkgRes.data.messagePackages ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rates) {
    return (
      <Card title="تعرفه مصرف و اعتبار">
        {error ? <ErrorBox>{error}</ErrorBox> : <SkeletonRows rows={6} />}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}

      <AiRatesCard rates={rates} canManage={canManage} busy={busy === "ai"} onBusy={setBusy} onSaved={async (r) => { setRates(r); setInfo("تعرفهٔ هوش مصنوعی ذخیره شد."); }} onError={setError} />
      <MessagingRatesCard rates={rates} canManage={canManage} busy={busy === "messaging"} onBusy={setBusy} onSaved={async (r) => { setRates(r); setInfo("تعرفهٔ پیام‌رسانی ذخیره شد."); }} onError={setError} />
      <MediaRatesCard rates={rates} canManage={canManage} busy={busy === "media"} onBusy={setBusy} onSaved={async (r) => { setRates(r); setInfo("تعرفهٔ رسانه ذخیره شد."); }} onError={setError} />

      <Card title="بسته‌های شارژ کیف پول">
        <p className="mb-3 text-xs text-muted-foreground">
          اعتبار عمومی پلتفرم: هوش مصنوعی، تمدید اشتراک و هزینه‌های مصرفی همه از همین کیف پول کسر می‌شوند.
        </p>
        <PackagesEditor
          kind="wallet"
          packages={packages.map((p) => ({ id: p.id, name: p.name, priceRial: p.priceRial, creditRial: p.creditRial, isActive: p.isActive }))}
          canManage={canManage}
          busy={busy}
          onBusy={setBusy}
          onReload={load}
          onError={setError}
        />
      </Card>

      <Card title="بسته‌های اعتبار پیام‌رسانی">
        <p className="mb-3 text-xs text-muted-foreground">
          اعتبار اختصاصی پیام (پیامک/ایمیل) که کسب‌وکارها برای ارسال کمپین‌ها مصرف می‌کنند. مدیریت تعرفه‌ها فقط از همین بخش انجام می‌شود؛{" "}
          <Link href="/platform/messaging" className="underline">بخش پیام‌رسانی</Link> فقط وضعیت فنی را نشان می‌دهد.
        </p>
        <PackagesEditor
          kind="messaging"
          packages={messagePackages.map((p) => ({ id: p.id, name: p.name, priceRial: p.priceRial, creditRial: p.creditAmountRial, isActive: p.isActive }))}
          canManage={canManage}
          busy={busy}
          onBusy={setBusy}
          onReload={load}
          onError={setError}
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AiRatesCard({
  rates,
  canManage,
  busy,
  onBusy,
  onSaved,
  onError,
}: {
  rates: RatesData;
  canManage: boolean;
  busy: boolean;
  onBusy: (key: string | null) => void;
  onSaved: (rates: RatesData) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [usdRate, setUsdRate] = useState(rates.ai.usdRialRate ? String(rates.ai.usdRialRate) : "");
  const [maxTurn, setMaxTurn] = useState(String(Math.round(rates.ai.maxTurnRial / 10)));
  const [inputRate, setInputRate] = useState(String(rates.ai.inputCostRialPerMillion));
  const [outputRate, setOutputRate] = useState(String(rates.ai.outputCostRialPerMillion));
  const [marginPct, setMarginPct] = useState(String(rates.ai.revenueMarginPercent));
  const [costingEnabled, setCostingEnabled] = useState(rates.ai.gatewayCostingEnabled);
  useEffect(() => {
    setUsdRate(rates.ai.usdRialRate ? String(rates.ai.usdRialRate) : "");
    setMaxTurn(String(Math.round(rates.ai.maxTurnRial / 10)));
    setInputRate(String(rates.ai.inputCostRialPerMillion));
    setOutputRate(String(rates.ai.outputCostRialPerMillion));
    setMarginPct(String(rates.ai.revenueMarginPercent));
    setCostingEnabled(rates.ai.gatewayCostingEnabled);
  }, [
    rates.ai.usdRialRate,
    rates.ai.maxTurnRial,
    rates.ai.inputCostRialPerMillion,
    rates.ai.outputCostRialPerMillion,
    rates.ai.revenueMarginPercent,
    rates.ai.gatewayCostingEnabled,
  ]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const parsedUsd =
      usdRate.trim() === "" ? 0 : parseSafeIntInput(usdRate, { min: 0 });
    const parsedMaxTurn = parseSafeIntInput(maxTurn, { min: 0 });
    const parsedInput = parseSafeIntInput(inputRate, { min: 0 });
    const parsedOutput = parseSafeIntInput(outputRate, { min: 0 });
    const parsedMargin = parseSafeIntInput(marginPct, { min: 0, max: 1000 });
    if (
      parsedUsd === null ||
      parsedMaxTurn === null ||
      parsedInput === null ||
      parsedOutput === null ||
      parsedMargin === null
    ) {
      onError("مقادیر واردشده برای تعرفهٔ هوش مصنوعی معتبر نیستند.");
      return;
    }

    onBusy("ai");
    const { ok, data } = await api<RatesData & { error?: string }>("/api/platform/billing/rates", {
      method: "PUT",
      body: JSON.stringify({
        ai: {
          usdRialRate: parsedUsd > 0 ? parsedUsd : null,
          maxTurnRial: parsedMaxTurn * 10,
          inputCostRialPerMillion: parsedInput,
          outputCostRialPerMillion: parsedOutput,
          revenueMarginPercent: parsedMargin,
          gatewayCostingEnabled: costingEnabled,
        },
      }),
    });
    onBusy(null);
    if (ok) await onSaved(data);
    else onError(data.error === "INVALID_AMOUNT" ? "مقادیر واردشده معتبر نیستند." : data.error ?? "ذخیره انجام نشد.");
  }

  return (
    <Card title="هوش مصنوعی — تعرفه و پیش‌بررسی اعتبار">
      <form onSubmit={save} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field label="نرخ تبدیل دلار به ریال" hint="هزینهٔ گزارش‌شدهٔ LiteLLM (دلار) با این نرخ به ریال تبدیل و از کیف پول کسر می‌شود.">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={usdRate} onChange={(e) => setUsdRate(e.target.value)} disabled={!canManage} placeholder="مثلاً ۷۰۰٬۰۰۰" />
          </Field>
          <Field
            label="حداقل اعتبار لازم / آستانهٔ پیش‌بررسی هر گفت‌وگو (تومان)"
            hint="پیش از آغاز هر نوبت، وجود این مقدار اعتبار آزاد (سهمیهٔ پلن + کیف پول منهای بدهی) بررسی می‌شود. هزینهٔ واقعی پس از اجرا کامل تسویه شده و مازاد در بدهی هوش مصنوعی ثبت می‌گردد."
          >
            <PersianNumberInput className={inputClass} inputMode="numeric" value={maxTurn} onChange={(e) => setMaxTurn(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="حاشیهٔ سود روی نرخ توکن (٪)" hint="در صورت نبود گزارش دلاری درگاه، به نرخ پایهٔ توکن افزوده می‌شود.">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={marginPct} onChange={(e) => setMarginPct(e.target.value)} disabled={!canManage} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field label="نرخ پایهٔ هر میلیون توکن ورودی (ریال)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={inputRate} onChange={(e) => setInputRate(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="نرخ پایهٔ هر میلیون توکن خروجی (ریال)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={outputRate} onChange={(e) => setOutputRate(e.target.value)} disabled={!canManage} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={costingEnabled} onChange={(e) => setCostingEnabled(e.target.checked)} disabled={!canManage} className="size-4" />
            تسویه بر پایهٔ گزارش LiteLLM فعال باشد
          </label>
        </div>
        {canManage && (
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
            ذخیرهٔ تعرفهٔ هوش مصنوعی
          </Button>
        )}
      </form>
      <p className="mt-3 text-xs text-muted-foreground">
        اعتبار ماهانهٔ هوش مصنوعیِ هر پلن در تب «پلن‌ها و بسته‌ها» تنظیم می‌شود. اتصال فنی LiteLLM (مدل‌ها، کلیدها و مسیریابی) در{" "}
        <Link href="/platform/ai" className="underline">بخش هوش مصنوعی</Link> مدیریت می‌شود.
      </p>
    </Card>
  );
}

function MessagingRatesCard({
  rates,
  canManage,
  busy,
  onBusy,
  onSaved,
  onError,
}: {
  rates: RatesData;
  canManage: boolean;
  busy: boolean;
  onBusy: (key: string | null) => void;
  onSaved: (rates: RatesData) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [sms, setSms] = useState(String(rates.messaging.rate.smsRialPerSegment));
  const [email, setEmail] = useState(String(rates.messaging.rate.emailRialPerSend));
  useEffect(() => {
    setSms(String(rates.messaging.rate.smsRialPerSegment));
    setEmail(String(rates.messaging.rate.emailRialPerSend));
  }, [rates.messaging.rate.smsRialPerSegment, rates.messaging.rate.emailRialPerSend]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const parsedSms = parseSafeIntInput(sms, { min: 0 });
    const parsedEmail = parseSafeIntInput(email, { min: 0 });
    if (parsedSms === null || parsedEmail === null) {
      onError("تعرفه‌ها باید اعداد صحیح صفر یا بزرگ‌تر باشند.");
      return;
    }
    onBusy("messaging");
    const { ok, data } = await api<RatesData & { error?: string }>("/api/platform/billing/rates", {
      method: "PUT",
      body: JSON.stringify({
        messaging: {
          smsRialPerSegment: parsedSms,
          emailRialPerSend: parsedEmail,
        },
      }),
    });
    onBusy(null);
    if (ok) await onSaved(data);
    else onError(data.error === "INVALID_AMOUNT" ? "تعرفه‌ها باید اعداد صفر یا بزرگ‌تر باشند." : data.error ?? "ذخیره انجام نشد.");
  }

  return (
    <Card title="پیام‌رسانی — تعرفهٔ هر پیام">
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-3 sm:items-end">
        <Field label="هزینهٔ هر قطعه پیامک (ریال)" hint="پیامک فارسی بر پایهٔ قطعهٔ ۷۰/۶۷ نویسه محاسبه می‌شود.">
          <PersianNumberInput className={inputClass} inputMode="numeric" value={sms} onChange={(e) => setSms(e.target.value)} disabled={!canManage} />
        </Field>
        <Field label="هزینهٔ هر ایمیل (ریال)">
          <PersianNumberInput className={inputClass} inputMode="numeric" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!canManage} />
        </Field>
        {canManage && (
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
            ذخیرهٔ تعرفهٔ پیام‌رسانی
          </Button>
        )}
      </form>
      <p className="mt-3 text-xs text-muted-foreground">
        اتصال ارائه‌دهندگان (کاوه‌نگار، SMTP) در <Link href="/platform/messaging" className="underline">بخش پیام‌رسانی</Link> تنظیم می‌شود؛ قیمت فقط از همین‌جا.
      </p>
    </Card>
  );
}

function MediaRatesCard({
  rates,
  canManage,
  busy,
  onBusy,
  onSaved,
  onError,
}: {
  rates: RatesData;
  canManage: boolean;
  busy: boolean;
  onBusy: (key: string | null) => void;
  onSaved: (rates: RatesData) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [billingEnabled, setBillingEnabled] = useState(rates.media.billingEnabled);
  const [flat, setFlat] = useState(String(Math.round(rates.media.dailyFlatRial / 10)));
  const [perGb, setPerGb] = useState(String(Math.round(rates.media.dailyPerGbRial / 10)));
  const [freeQuota, setFreeQuota] = useState(String(rates.media.freeQuotaMb));
  const [enhance, setEnhance] = useState(String(Math.round(rates.media.enhancePriceRial / 10)));
  useEffect(() => {
    setBillingEnabled(rates.media.billingEnabled);
    setFlat(String(Math.round(rates.media.dailyFlatRial / 10)));
    setPerGb(String(Math.round(rates.media.dailyPerGbRial / 10)));
    setFreeQuota(String(rates.media.freeQuotaMb));
    setEnhance(String(Math.round(rates.media.enhancePriceRial / 10)));
  }, [rates.media]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const parsedFlat = parseSafeIntInput(flat, { min: 0 });
    const parsedPerGb = parseSafeIntInput(perGb, { min: 0 });
    const parsedFree = parseSafeIntInput(freeQuota, { min: 0 });
    const parsedEnhance = parseSafeIntInput(enhance, { min: 0 });
    if (
      parsedFlat === null ||
      parsedPerGb === null ||
      parsedFree === null ||
      parsedEnhance === null
    ) {
      onError("مقادیر تعرفهٔ رسانه باید اعداد صحیح صفر یا بزرگ‌تر باشند.");
      return;
    }
    onBusy("media");
    const { ok, data } = await api<RatesData & { error?: string }>("/api/platform/billing/rates", {
      method: "PUT",
      body: JSON.stringify({
        media: {
          billingEnabled,
          dailyFlatRial: parsedFlat * 10,
          dailyPerGbRial: parsedPerGb * 10,
          freeQuotaMb: parsedFree,
          enhancePriceRial: parsedEnhance * 10,
        },
      }),
    });
    onBusy(null);
    if (ok) await onSaved(data);
    else onError(data.error === "invalid_price" ? "مقادیر تعرفه باید عدد صفر یا بزرگ‌تر باشند." : data.error ?? "ذخیره انجام نشد.");
  }

  return (
    <Card title="رسانه — تعرفهٔ نگهداری روزانه و پردازش">
      <form onSubmit={save} className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={billingEnabled} onChange={(e) => setBillingEnabled(e.target.checked)} disabled={!canManage} className="size-4" />
          کسر هزینهٔ نگهداری روزانه فعال باشد
        </label>
        <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
          <Field label="هزینهٔ ثابت روزانه (تومان)" hint="برای هر کسب‌وکارِ دارای فایل.">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={flat} onChange={(e) => setFlat(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="هزینهٔ هر گیگابایت روزانه (تومان)" hint="فقط برای حجم مازاد بر سهمیهٔ رایگان.">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={perGb} onChange={(e) => setPerGb(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="سهمیهٔ رایگان (مگابایت)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={freeQuota} onChange={(e) => setFreeQuota(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="هزینهٔ هر بهبود تصویر با هوش مصنوعی (تومان)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={enhance} onChange={(e) => setEnhance(e.target.value)} disabled={!canManage} />
          </Field>
        </div>
        {canManage && (
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}
            ذخیرهٔ تعرفهٔ رسانه
          </Button>
        )}
      </form>
      <p className="mt-3 text-xs text-muted-foreground">
        اتصال فنی ذخیره‌سازی (S3/پارس‌پک) در <Link href="/platform/media" className="underline">بخش رسانه</Link> تنظیم می‌شود؛ قیمت فقط از همین‌جا.
      </p>
    </Card>
  );
}

function PackagesEditor({
  kind,
  packages,
  canManage,
  busy,
  onBusy,
  onReload,
  onError,
}: {
  kind: "wallet" | "messaging";
  packages: { id: string; name: string; priceRial: number; creditRial: number; isActive: boolean }[];
  canManage: boolean;
  busy: string | null;
  onBusy: (key: string | null) => void;
  onReload: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [credit, setCredit] = useState("");

  async function add(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const parsedPrice = parseSafeIntInput(price, { min: 1 });
    const parsedCredit = parseSafeIntInput(credit, { min: 1 });
    if (!name.trim() || parsedPrice === null || parsedCredit === null) {
      onError("نام بسته، مبلغ پرداختی و مبلغ اعتبار (عدد صحیح بزرگ‌تر از صفر) الزامی است.");
      return;
    }
    const priceRial = parsedPrice * 10;
    const creditRial = parsedCredit * 10;
    onBusy(`pkg-${kind}`);
    const { ok, data } = await api<{ error?: string }>("/api/platform/billing/packages", {
      method: "POST",
      body: JSON.stringify({ kind, name: name.trim(), priceRial, creditRial, isActive: true, sortOrder: packages.length + 1 }),
    });
    onBusy(null);
    if (ok) {
      setName("");
      setPrice("");
      setCredit("");
      await onReload();
    } else {
      onError(data.error ?? "ذخیره بسته انجام نشد.");
    }
  }

  async function toggle(pkg: { id: string; name: string; priceRial: number; creditRial: number; isActive: boolean }) {
    onBusy(`pkg-t-${pkg.id}`);
    await api("/api/platform/billing/packages", {
      method: "POST",
      body: JSON.stringify({
        kind,
        id: pkg.id,
        name: pkg.name,
        priceRial: pkg.priceRial,
        creditRial: pkg.creditRial,
        isActive: !pkg.isActive,
      }),
    });
    onBusy(null);
    await onReload();
  }

  async function remove(id: string) {
    onBusy(`pkg-del-${id}`);
    await api(`/api/platform/billing/packages/${id}`, { method: "DELETE" });
    onBusy(null);
    await onReload();
  }

  return (
    <div>
      {canManage && (
        <form onSubmit={add} className="mb-4 grid gap-3 sm:grid-cols-4 sm:items-end">
          <Field label="نام بسته">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً بستهٔ ۲۰۰ هزار تومانی" />
          </Field>
          <Field label="قیمت پرداختی (تومان)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="200000" />
          </Field>
          <Field label="اعتبار اهدایی (تومان)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="220000" />
          </Field>
          <Button type="submit" disabled={busy === `pkg-${kind}`}>
            {busy === `pkg-${kind}` ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
            افزودن بسته
          </Button>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-right text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2 pr-1">نام</th>
              <th className="py-2">قیمت</th>
              <th className="py-2">اعتبار</th>
              <th className="py-2">وضعیت</th>
              {canManage && <th className="py-2" />}
            </tr>
          </thead>
          <tbody>
            {packages.map((pkg) => (
              <tr key={pkg.id} className="border-b border-border">
                <td className="py-2 pr-1 font-medium text-foreground">{pkg.name}</td>
                <td className="py-2 tabular-nums">{tomanLabel(pkg.priceRial)}</td>
                <td className="py-2 tabular-nums">
                  {tomanLabel(pkg.creditRial)}
                  {pkg.creditRial > pkg.priceRial && (
                    <span className="mr-1 text-xs text-emerald-700 dark:text-emerald-300">(+{tomanLabel(pkg.creditRial - pkg.priceRial)})</span>
                  )}
                </td>
                <td className="py-2">
                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => void toggle(pkg)}
                      disabled={busy?.startsWith("pkg")}
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        pkg.isActive
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {pkg.isActive ? "فعال" : "غیرفعال"}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">{pkg.isActive ? "فعال" : "غیرفعال"}</span>
                  )}
                </td>
                {canManage && kind === "wallet" && (
                  <td className="py-2 text-left">
                    <button
                      type="button"
                      onClick={() => void remove(pkg.id)}
                      disabled={busy?.startsWith("pkg")}
                      className="text-red-700 dark:text-red-300 hover:text-red-800 dark:hover:text-red-200"
                      aria-label="حذف بسته"
                    >
                      <Trash2Icon className="size-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {packages.length === 0 && (
              <tr>
                <td colSpan={canManage ? 5 : 4} className="py-6 text-center text-muted-foreground">
                  بسته‌ای تعریف نشده است.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        مبالغ پایه به ریال نگهداری می‌شوند ({formatRial(10)} ریال = ۱ تومان) و در رابط کاربری به تومان نمایش داده می‌شوند.
      </p>
    </div>
  );
}
