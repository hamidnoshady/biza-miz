"use client";

/**
 * «لوگو» — the business logo used on every printed document.
 *
 * Centralized under Business Settings → Business Identity per #945: the single
 * business-wide logo stored at `business.logo` (GET/POST/DELETE
 * /api/settings/business/logo). Printing templates reference it via print
 * branding contract; no logo uploader remains in printing section.
 */
import { useRef, useState } from "react";
import { ImageUpIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LOGO_MAX_BYTES } from "@/lib/business-logo";
import { toPersianDigits } from "@/lib/digits";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, api, errorMessage } from "@/app/dashboard/ui";
import type { LogoRecord } from "./use-printing";

const ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";

export function LogoPanel({ logo, onChanged }: { logo: LogoRecord | null; onChanged: () => Promise<void> | void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function upload(file: File) {
    setBusy(true);
    setError("");
    setNotice("");
    if (file.size > LOGO_MAX_BYTES) {
      setBusy(false);
      setError(`حجم فایل باید کمتر از ${toPersianDigits(Math.round(LOGO_MAX_BYTES / 1024))} کیلوبایت باشد.`);
      return;
    }
    const form = new FormData();
    form.append("file", file);
    const { ok, data } = await api<{ error?: string }>("/api/settings/business/logo", { method: "POST", body: form });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("لوگو ذخیره شد و از این پس روی اسناد چاپ می‌شود.");
    await onChanged();
  }

  async function remove() {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/settings/business/logo", { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("لوگو حذف شد؛ قالب‌ها بدون لوگو چاپ می‌شوند.");
    await onChanged();
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard
        title="لوگوی کسب‌وکار"
        description="روی رسید و فاکتور چاپ می‌شود. تصویر تک‌رنگ و پرکنتراست روی چاپگر حرارتی بهترین نتیجه را می‌دهد."
      >
        <div className="grid gap-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-start">
          <div className="rounded-xl border border-dashed border-border p-4 text-center">
            {logo ? (

              <img src={logo.dataUrl} alt="لوگوی کسب‌وکار" className="mx-auto max-h-32 w-auto object-contain" />
            ) : (
              <p className="py-8 text-sm text-muted-foreground">هنوز لوگویی بارگذاری نشده است.</p>
            )}
          </div>

          <div className="space-y-3">
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
                <ImageUpIcon aria-hidden="true" />
                {busy ? "در حال بارگذاری…" : logo ? "جایگزینی لوگو" : "بارگذاری لوگو"}
              </Button>
              {logo ? (
                <Button type="button" variant="outline" onClick={() => void remove()} disabled={busy}>
                  <Trash2Icon aria-hidden="true" />
                  حذف لوگو
                </Button>
              ) : null}
            </div>
            <ul className="space-y-1 text-xs leading-6 text-muted-foreground">
              <li>فرمت‌های مجاز: PNG، JPEG، WebP و SVG.</li>
              <li>حداکثر حجم: {toPersianDigits(Math.round(LOGO_MAX_BYTES / 1024))} کیلوبایت.</li>
              <li>برای چاپگر حرارتی، لوگوی سیاه‌وسفید با پس‌زمینهٔ شفاف یا سفید پیشنهاد می‌شود.</li>
              <li>ارتفاع چاپ لوگو در هر قالب، از بخش «لوگو» همان قالب تنظیم می‌شود.</li>
            </ul>
            {logo ? (
              <p className="text-xs text-muted-foreground">
                حجم فعلی: {toPersianDigits(Math.round(logo.byteLength / 1024))} کیلوبایت
              </p>
            ) : null}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
