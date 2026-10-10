"use client";
import { useEffect, useState } from "react";
import { SectionCard, LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, InfoBox, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";

export function TaxArchiveSettings() {
  const [days, setDays] = useState("365");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api<{ archiveAfterDays: number }>("/api/ledger/tax-invoices/archive").then((res) => {
      if (cancelled) return;
      if (res.ok) { setDays(String(res.data.archiveAfterDays)); setLoaded(true); }
      else setError("سیاست بایگانی بارگذاری نشد.");
    });
    return () => { cancelled = true; };
  }, []);
  async function run(method: "PUT" | "POST") {
    setBusy(true); setError(""); setNotice("");
    const res = await api<{ archived?: number; message?: string }>("/api/ledger/tax-invoices/archive", {
      method, ...(method === "PUT" ? { body: JSON.stringify({ archiveAfterDays: Number(days) }) } : {}),
    });
    setBusy(false);
    if (!res.ok) setError(res.data.message ?? "بایگانی انجام نشد.");
    else setNotice(method === "PUT" ? "سیاست بایگانی ذخیره شد." : "بایگانی رکوردهای واجد شرایط انجام شد.");
  }
  return (
    <SectionCard title="بایگانی و نگهداری صورتحساب‌ها" description="نگهداری دائمی است؛ هیچ رکورد پذیرفته‌شده‌ای حذف نمی‌شود. رکوردهای نهایی قدیمی به بایگانی تغییرناپذیر افزوده می‌شوند. این مهلت فقط زمان بایگانی است، نه مهلت حذف قانونی.">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {!loaded && !error ? <LoadingSkeleton rows={2} label="بارگذاری سیاست بایگانی" /> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {loaded ? <div className="space-y-3">
        <Field label="روز تا بایگانی">
          <PersianNumberInput className={inputClass} value={days} allowNegative={false} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton disabled={busy} onClick={() => void run("PUT")}>ذخیره سیاست بایگانی</PrimaryButton>
          <SecondaryButton disabled={busy} onClick={() => void run("POST")}>بایگانی رکوردهای قدیمی</SecondaryButton>
        </div>
      </div> : null}
    </SectionCard>
  );
}
