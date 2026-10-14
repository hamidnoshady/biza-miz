"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, ErrorBox, errorMessage, InfoBox, PrimaryButton, SetupDataSkeleton, StepShell } from "../ui";
import { nextPath, skipToPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";
import { industryProfile, type SalesModel } from "@/lib/industry-profile";

type Method = "fifo" | "lifo" | "weighted_average";
type System = "perpetual" | "periodic";

interface CostingResponse {
  costing: { method: Method; system?: System; lockedAt: string | null } | null;
  locked: boolean;
  error?: string;
}

interface Option {
  value: Method;
  title: string;
  example: string;
}

/**
 * The costing methods, explained in the caller's own trade.
 *
 * Keyed on `salesModel` rather than on `industry` so a fifth industry inherits
 * whichever wording its profile already declares, instead of needing a case
 * here (CLAUDE.md: prefer the profile over an `if (industry === …)`).
 *
 * «مواد مصرفی» / a coffee example is F&B's wording and stays exactly as it
 * was; a shop consumes nothing — it buys goods and sells them — so the retail
 * copy talks about بهای تمام‌شدهٔ کالای فروش‌رفته and counts pieces, not kilos.
 */
const COPY: Record<SalesModel, { description: string; options: Option[] }> = {
  order_ticket: {
    description:
      "مشخص می‌کند بهای تمام‌شدهٔ مواد مصرفی چطور محاسبه شود. بعد از اولین تراکنش انبار این انتخاب قفل می‌شود.",
    options: [
      {
        value: "fifo",
        title: "اولین صادره از اولین وارده (FIFO)",
        example:
          "مثال: اول ۱۰ کیلو قهوه کیلویی ۵۰۰ هزار تومان خریده‌اید و بعد ۱۰ کیلو کیلویی ۶۰۰ هزار تومان. تا وقتی خرید اول تمام نشده، مصرف با همان کیلویی ۵۰۰ حساب می‌شود و بعد سراغ خرید دوم می‌رود. یعنی بهای مصرف دقیقاً به ترتیب خریدها است.",
      },
      {
        value: "lifo",
        title: "اولین صادره از آخرین وارده (LIFO)",
        example:
          "مثال: با همان دو خرید، مصرف اول از خرید جدیدتر (کیلویی ۶۰۰) حساب می‌شود و وقتی تمام شد سراغ خرید قدیمی‌تر می‌رود. یعنی بهای مصرف همیشه به قیمت‌های تازه‌تر نزدیک‌تر است. توجه: این روش در استاندارد حسابداری ایران و IFRS مجاز نیست و بیشتر جنبه مقایسه‌ای/مدیریتی دارد.",
      },
      {
        value: "weighted_average",
        title: "میانگین موزون",
        example:
          "مثال: با همان دو خرید، میانگین قیمت می‌شود کیلویی ۵۵۰ هزار تومان و هر مصرفی با همین میانگین حساب می‌شود. یعنی قیمت‌ها با هم مخلوط می‌شوند و محاسبه ساده‌تر است.",
      },
    ],
  },
  retail_invoice: {
    description:
      "مشخص می‌کند بهای تمام‌شدهٔ کالای فروش‌رفته چطور محاسبه شود. بعد از اولین تراکنش انبار این انتخاب قفل می‌شود.",
    options: [
      {
        value: "fifo",
        title: "اولین صادره از اولین وارده (FIFO)",
        example:
          "مثال: اول ۱۰ عدد از یک کالا را دانه‌ای ۵۰۰ هزار تومان خریده‌اید و بعد ۱۰ عدد دیگر را دانه‌ای ۶۰۰ هزار تومان. تا وقتی خرید اول تمام نشده، بهای کالای فروش‌رفته با همان دانه‌ای ۵۰۰ حساب می‌شود و بعد سراغ خرید دوم می‌رود. یعنی بهای تمام‌شده دقیقاً به ترتیب خریدها است.",
      },
      {
        value: "lifo",
        title: "اولین صادره از آخرین وارده (LIFO)",
        example:
          "مثال: با همان دو خرید، بهای فروش اول از خرید جدیدتر (دانه‌ای ۶۰۰) حساب می‌شود و وقتی تمام شد سراغ خرید قدیمی‌تر می‌رود. یعنی بهای تمام‌شده همیشه به قیمت‌های تازه‌تر نزدیک‌تر است. توجه: این روش در استاندارد حسابداری ایران و IFRS مجاز نیست و بیشتر جنبه مقایسه‌ای/مدیریتی دارد.",
      },
      {
        value: "weighted_average",
        title: "میانگین موزون",
        example:
          "مثال: با همان دو خرید، میانگین قیمت می‌شود دانه‌ای ۵۵۰ هزار تومان و بهای هر فروش با همین میانگین حساب می‌شود. یعنی قیمت‌ها با هم مخلوط می‌شوند و محاسبه ساده‌تر است.",
      },
    ],
  },
};

const SYSTEM_OPTIONS: Array<{ value: System; title: string; example: string }> = [
  {
    value: "perpetual",
    title: "سیستم دائمی (Perpetual)",
    example:
      "با هر فروش، موجودی همان لحظه کم و بهای تمام‌شده ثبت می‌شود. موجودی و سود ناخالص همیشه به‌روز است؛ انبارگردانی فقط برای کشف مغایرت است. پیشنهاد ما برای اکثر کسب‌وکارها همین است.",
  },
  {
    value: "periodic",
    title: "سیستم ادواری (Periodic)",
    example:
      "در طول دوره هیچ بهایی لحظه‌ای ثبت نمی‌شود: خریدها به حساب «خرید طی دوره» می‌روند و فروش فقط درآمد ثبت می‌کند. در پایان هر دوره موجودی را می‌شمارید و سیستم «اول دوره + خرید − پایان دوره» را به‌عنوان بهای تمام‌شده ثبت می‌کند. ساده‌تر است اما موجودی لحظه‌ای، ضایعات، تولید و انتقال بین انبارها را ندارد.",
  },
];

export default function CostingStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = useMemo(() => stepsFor(industry), [industry]);
  // Costing (FIFO/weighted-average for inventory_items) is an F&B-only
  // concept -- a jewelry business landing here (a stale link, the back
  // button) belongs at whatever step actually follows it in their flow.
  const available = steps.some((s) => s.id === "costing");
  const copy = COPY[industryProfile(industry).salesModel];
  const [method, setMethod] = useState<Method>("weighted_average");
  const [system, setSystem] = useState<System>("perpetual");
  const [locked, setLocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!available) {
      router.replace(skipToPath("costing", steps));
      return;
    }
    setLoaded(false);
    void api<CostingResponse>("/api/setup/costing")
      .then(({ ok, data }) => {
        if (!ok) {
          setError(errorMessage(data.error));
          return;
        }
        if (data.costing?.method) setMethod(data.costing.method);
        if (data.costing?.system) setSystem(data.costing.system);
        setLocked(Boolean(data.locked));
      })
      .catch(() => setError("بارگذاری روش قیمت‌گذاری ممکن نشد."))
      .finally(() => setLoaded(true));
  }, [available, router, steps]);

  if (!available) return null;
  if (!loaded) return <SetupDataSkeleton rows={2} />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (locked) {
      router.push(nextPath("costing"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>("/api/setup/costing", {
        method: "POST",
        body: JSON.stringify({ method, system }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      router.push(nextPath("costing"));
    } finally {
      setBusy(false);
    }
  }

  const radioCard = (checked: boolean) =>
    `block cursor-pointer rounded-xl border p-4 transition ${
      checked
        ? "border-primary bg-primary/5 ring-2 ring-ring/30"
        : "border-border hover:border-muted-foreground/40"
    } ${locked ? "opacity-70" : ""}`;

  return (
    <StepShell step="costing" description={copy.description}>
      {locked ? (
        <InfoBox>
          روش قیمت‌گذاری قفل شده است (اولین تراکنش انبار ثبت شده). تغییر آن فقط از طریق فرایند
          رسمی تجدید ارزیابی در فازهای بعدی ممکن است.
        </InfoBox>
      ) : null}
      <form onSubmit={submit} className="max-w-2xl">
        <ErrorBox>{error}</ErrorBox>
        <p className="mb-3 font-semibold">سیستم نگهداری موجودی</p>
        <div className="space-y-3">
          {SYSTEM_OPTIONS.map((o) => (
            <label key={o.value} className={radioCard(system === o.value)}>
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="system"
                  checked={system === o.value}
                  disabled={locked}
                  onChange={() => setSystem(o.value)}
                />
                <span className="font-semibold">{o.title}</span>
              </span>
              <span className="mt-2 block text-sm leading-6 text-muted-foreground">{o.example}</span>
            </label>
          ))}
        </div>
        <p className="mb-3 mt-6 font-semibold">روش قیمت‌گذاری</p>
        {system === "periodic" ? (
          <p className="mb-3 text-sm leading-6 text-muted-foreground">
            در سیستم ادواری، این روش در پایان هر دوره روی موجودی شمارش‌شده اعمال می‌شود — «میانگین
            موزون» به معنی کلاسیک آن (سرجمع ارزش تقسیم بر سرجمع تعداد کل دوره) محاسبه می‌شود.
          </p>
        ) : null}
        <div className="space-y-3">
          {copy.options.map((o) => (
            <label key={o.value} className={radioCard(method === o.value)}>
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="method"
                  checked={method === o.value}
                  disabled={locked}
                  onChange={() => setMethod(o.value)}
                />
                <span className="font-semibold">{o.title}</span>
              </span>
              <span className="mt-2 block text-sm leading-6 text-muted-foreground">{o.example}</span>
            </label>
          ))}
        </div>
        <div className="mt-6">
          <PrimaryButton disabled={busy}>{locked ? "ادامه" : "انتخاب و ادامه"}</PrimaryButton>
        </div>
      </form>
    </StepShell>
  );
}
