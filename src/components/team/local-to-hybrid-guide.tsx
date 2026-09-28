"use client";

import { useMemo, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, PrimaryButton, SecondaryButton, inputClass } from "@/app/dashboard/ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface ConversionMember { id: string; fullName: string; email: string | null; role: string; isActive: boolean }
export interface ConversionPreview { identityMap: Record<string, string>; mapped: ConversionMember[]; disabled: ConversionMember[]; errors: string[] }

export function buildConversionPreview(members: ConversionMember[], values: Record<string, string>): ConversionPreview {
  const active = members.filter((member) => member.isActive);
  const identityMap: Record<string, string> = {};
  const errors: string[] = [];
  for (const member of active) {
    const value = values[member.id]?.trim();
    if (!value) continue;
    if (!UUID.test(value)) errors.push(`شناسهٔ ابری «${member.fullName}» معتبر نیست.`);
    else identityMap[member.id] = value;
  }
  const mapped = active.filter((member) => Boolean(identityMap[member.id]));
  const disabled = active.filter((member) => !identityMap[member.id]);
  if (!mapped.some((member) => member.role === "owner")) errors.push("حداقل یک مالک فعال باید به هویت ابری نگاشت شود.");
  return { identityMap, mapped, disabled, errors };
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

export function LocalToHybridGuide({ members }: { members: ConversionMember[] }) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const preview = useMemo(() => buildConversionPreview(members, values), [members, values]);
  const active = members.filter((member) => member.isActive);

  function exportFiles() {
    if (preview.errors.length || !confirmed) return;
    download("local-to-hybrid-identity-map.json", `${JSON.stringify(preview.identityMap, null, 2)}\n`, "application/json");
    if (preview.disabled.length) {
      const csv = ["local_membership_id,email,full_name", ...preview.disabled.map((member) =>
        [member.id, member.email ?? "", member.fullName].map((value) => `"${value.replaceAll('"', '""')}"`).join(","),
      )].join("\n");
      download("local-to-hybrid-invitations.csv", `${csv}\n`, "text/csv;charset=utf-8");
    }
  }

  return <SectionCard title="تبدیل محلی به هیبرید" description="هویت‌های محلی را پیش از اجرای تبدیل با هویت‌های موجود ابری تطبیق دهید.">
    {!open ? <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">هیچ رمز عبور، PIN، نشست یا کلید امنیتی به فضای ابری منتقل نمی‌شود.</p>
      <SecondaryButton onClick={() => setOpen(true)}>شروع راهنمای تبدیل</SecondaryButton>
    </div> : <div className="space-y-5">
      <InfoBox>شناسهٔ هویت ابری را از کنسول ابری وارد کنید. اعتبار و فعال‌بودن شناسه‌ها دوباره توسط ابزار تبدیل بررسی می‌شود.</InfoBox>
      {!review ? <>
        <div className="space-y-3">
          {active.map((member) => <label key={member.id} className="block rounded-xl border border-border p-3">
            <span className="mb-2 block text-sm font-medium">{member.fullName} · {member.role}{member.email ? ` · ${member.email}` : ""}</span>
            <input dir="ltr" className={inputClass} value={values[member.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [member.id]: event.target.value }))} placeholder="Cloud identity UUID — برای غیرفعال‌سازی خالی بگذارید" />
          </label>)}
        </div>
        <ErrorBox>{preview.errors.join(" ")}</ErrorBox>
        <div className="flex flex-wrap gap-2"><PrimaryButton disabled={preview.errors.length > 0} onClick={() => setReview(true)}>پیش‌نمایش نتیجه</PrimaryButton><SecondaryButton onClick={() => setOpen(false)}>بستن</SecondaryButton></div>
      </> : <>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-success/30 bg-success/5 p-4"><p className="font-semibold">نگاشت‌شده: {preview.mapped.length}</p><p className="mt-1 text-xs text-muted-foreground">این اعضا با هویت ابری موجود ادامه می‌دهند.</p></div>
          <div className="rounded-xl border border-warning/30 bg-warning/5 p-4"><p className="font-semibold">غیرفعال: {preview.disabled.length}</p><p className="mt-1 text-xs text-muted-foreground">برای این اعضا فایل دعوت ساخته می‌شود و پس از تبدیل باید از Cloud دعوت شوند.</p></div>
        </div>
        {preview.disabled.length ? <ul className="list-inside list-disc text-sm text-muted-foreground">{preview.disabled.map((member) => <li key={member.id}>{member.fullName}{member.email ? ` — ${member.email}` : " — بدون ایمیل"}</li>)}</ul> : null}
        <label className="flex items-start gap-2 rounded-xl border border-border p-3 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>تأیید می‌کنم اعضای بدون نگاشت غیرفعال می‌شوند، حداقل یک مالک نگاشت شده است و فایل‌ها را پیش از اجرای تبدیل بازبینی کرده‌ام.</span></label>
        <div className="flex flex-wrap gap-2"><PrimaryButton disabled={!confirmed} onClick={exportFiles}><Download className="size-4" />دریافت فایل نگاشت و دعوت‌ها</PrimaryButton><SecondaryButton onClick={() => { setReview(false); setConfirmed(false); }}>بازگشت و ویرایش</SecondaryButton></div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4" />سپس ابزار تبدیل را ابتدا با <code dir="ltr">--preview --identity-map</code> و پس از بازبینی با <code dir="ltr">--yes</code> اجرا کنید.</p>
      </>}
    </div>}
  </SectionCard>;
}
