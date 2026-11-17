"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { Button, buttonVariants } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { validateWeightAttributes } from "@/lib/gold";
import { validateServiceIntervalMonths } from "@/lib/watch";
import { PURITY_LABELS } from "../jewelry/jewelry-manager";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api, Field, inputClass } from "../ui";

type Industry = "jewelry" | "watch";
type Form = {
  name: string; sku: string; purity: string; grossWeight: string; netWeight: string;
  cost: string; costUnit: string; referenceNo: string; movement: string; serviceInterval: string;
  caseMaterial: string; caseDiameter: string; waterResistance: string; dialColor: string; braceletMaterial: string; gender: string;
};
type Draft = { form: Form; pending: boolean };
const EMPTY: Form = { name: "", sku: "", purity: "18", grossWeight: "", netWeight: "", cost: "", costUnit: "", referenceNo: "", movement: "", serviceInterval: "", caseMaterial: "", caseDiameter: "", waterResistance: "", dialColor: "", braceletMaterial: "", gender: "" };
const GENDERS = [["men", "مردانه"], ["women", "زنانه"], ["unisex", "یونیسکس"]] as const;
const MOVEMENTS = [["automatic", "اتوماتیک"], ["quartz", "کوارتز"], ["manual", "کوکی"], ["solar", "سولار"], ["kinetic", "کینتیک"], ["smart", "هوشمند"]] as const;

/** Ignore malformed or obsolete device-local data rather than trusting it as a request. */
function readDraft(key: string): Draft | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (!record.form || typeof record.form !== "object") return null;
  const stored = record.form as Record<string, unknown>;
  const form = { ...EMPTY };
  for (const field of Object.keys(form) as (keyof Form)[]) {
    if (typeof stored[field] === "string") form[field] = (stored[field] as string).slice(0, 1000);
  }
  return { form, pending: record.pending === true };
}

/** Uses the native creation APIs, not the variant product master. */
export function SpecialistProductCreate({ industry, draftScope, locationId, locationName }: { industry: Industry; draftScope: string; locationId: string; locationName: string }) {
  const key = `specialist-product-draft:v1:${industry}:${draftScope}`;
  const money = useMoney();
  const [draft, setDraft] = useState<Draft>({ form: EMPTY, pending: false });
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    try { setDraft(readDraft(key) ?? { form: EMPTY, pending: false }); }
    catch { setStorageError(true); }
    setReady(true);
  }, [key]);

  function persist(next: Draft): boolean {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStorageError(false);
      return true;
    } catch {
      setStorageError(true);
      return false;
    }
  }
  function change(field: keyof Form, value: string) {
    try {
      const saved = readDraft(key);
      if (saved?.pending) { setDraft(saved); setMessage("ثبت دیگری برای این پیش‌نویس نتیجهٔ نامشخص دارد؛ ابتدا آن را بررسی کنید."); return; }
    } catch { setStorageError(true); }
    const form = { ...draft.form, [field]: value };
    if (field === "cost") form.costUnit = money.unit;
    persist({ ...draft, form });
    setMessage("");
    setSuccess(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || draft.pending) return;
    // Another tab may already have started a submission for this draft.
    try {
      const saved = readDraft(key);
      if (saved?.pending) { setDraft(saved); setMessage("ثبت دیگری برای این پیش‌نویس نتیجهٔ نامشخص دارد؛ ابتدا آن را بررسی کنید."); return; }
    } catch {
      setStorageError(true);
      setMessage("ذخیره‌سازی مرورگر در دسترس نیست.");
      return;
    }
    const form = draft.form;
    if (!form.name.trim() || form.name.trim().length > 200) { setMessage("نام کالا الزامی و حداکثر ۲۰۰ نویسه است."); return; }
    let body: Record<string, unknown>;
    if (industry === "jewelry") {
      if (form.cost && form.costUnit !== money.unit) { setMessage("واحد پول از زمان ذخیرهٔ پیش‌نویس تغییر کرده است؛ بهای هر گرم را دوباره وارد کنید."); return; }
      let cost: string | null = null;
      try {
        if (form.cost) {
          const decimal = new Decimal(form.cost);
          if (!decimal.isFinite()) throw new Error();
          cost = (money.unit === "toman" ? decimal.mul(10) : decimal).toString();
        }
      } catch { setMessage("بهای هر گرم نامعتبر است."); return; }
      const weight = { purity: form.purity, grossWeight: form.grossWeight, netWeight: form.netWeight, unitCostPerGram: cost };
      const numbers = [weight.grossWeight, weight.netWeight];
      if (numbers.some((value) => { try { return !new Decimal(value).isFinite(); } catch { return true; } })) { setMessage("وزن‌ها باید عدد معتبر باشند."); return; }
      const errors = validateWeightAttributes(weight);
      if (errors.length) { setMessage(errors.join("؛ ")); return; }
      body = { name: form.name.trim(), sku: form.sku.trim() || null, ...weight, expectedLocationId: locationId };
    } else {
      const months = form.serviceInterval ? Number(form.serviceInterval) : null;
      const intervalError = validateServiceIntervalMonths(months);
      if (intervalError) { setMessage(intervalError); return; }
      if (form.movement && !MOVEMENTS.some(([value]) => value === form.movement)) { setMessage("نوع موتور نامعتبر است."); return; }
      if (form.gender && !GENDERS.some(([value]) => value === form.gender)) { setMessage("دسته‌بندی جنسیتی نامعتبر است."); return; }
      const diameter = form.caseDiameter ? Number(form.caseDiameter) : null;
      const resistance = form.waterResistance ? Number(form.waterResistance) : null;
      if (diameter != null && (!Number.isFinite(diameter) || diameter <= 0 || diameter > 100)) { setMessage("قطر قاب باید عددی بین ۰ و ۱۰۰ میلی‌متر باشد."); return; }
      if (resistance != null && (!Number.isInteger(resistance) || resistance < 0 || resistance > 10000)) { setMessage("مقاومت در برابر آب باید عددی صحیح و غیرمنفی (متر) باشد."); return; }
      body = { name: form.name.trim(), sku: form.sku.trim() || null, serviceIntervalMonths: months, attributes: {
        referenceNo: form.referenceNo.trim() || null, movement: form.movement || null,
        caseMaterial: form.caseMaterial.trim() || null, caseDiameterMm: diameter,
        waterResistanceM: resistance, dialColor: form.dialColor.trim() || null,
        braceletMaterial: form.braceletMaterial.trim() || null, gender: form.gender || null,
      }, expectedLocationId: locationId };
    }
    // Persist an uncertain-result marker before a write. A lost response or a
    // page reload must not invite an automatic duplicate POST.
    if (!persist({ form, pending: true })) { setMessage("ذخیرهٔ پیش‌نویس روی دستگاه ممکن نیست؛ برای جلوگیری از ثبت تکراری ابتدا ذخیره‌سازی مرورگر را فعال کنید."); setDraft({ form, pending: false }); return; }
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    let result: { ok: boolean; status: number; data: { ok?: boolean; id?: string; item?: { id?: string }; error?: string; message?: string } };
    try {
      result = await api(`/api/${industry}/items`, { method: "POST", body: JSON.stringify(body) });
    } catch {
      inFlight.current = false;
      setBusy(false);
      setMessage("نتیجهٔ ثبت مشخص نیست. پیش از تلاش دوباره، فهرست شعبه را بررسی کنید تا کالا تکراری ثبت نشود.");
      return;
    }
    inFlight.current = false;
    setBusy(false);
    // Do not overwrite edits made in another tab after it unlocked this draft.
    try {
      const saved = readDraft(key);
      if (!saved?.pending || JSON.stringify(saved.form) !== JSON.stringify(form)) {
        if (saved) setDraft(saved);
        setMessage("پیش‌نویس در صفحهٔ دیگری تغییر کرده است. نتیجهٔ ثبت قبلی را در فهرست محصولات بررسی کنید.");
        return;
      }
    } catch {
      setStorageError(true);
      setMessage("نتیجهٔ ثبت را در فهرست محصولات بررسی کنید؛ دسترسی به پیش‌نویس ممکن نیست.");
      return;
    }
    if (result.ok && result.data.ok === true && (industry === "jewelry" ? result.data.id : result.data.item?.id)) {
      persist({ form: EMPTY, pending: false });
      setSuccess(true);
    } else if ([400, 401, 403, 409, 422].includes(result.status) && ["bad_request", "missing_fields", "item_name_too_long", "invalid_weight_attributes", "no_location", "location_changed", "forbidden", "MISSING_PERMISSION", "industry_mismatch"].includes(result.data.error ?? "")) {
      persist({ form, pending: false });
      setMessage(result.data.error === "location_changed" ? "شعبهٔ فعال تغییر کرده است؛ صفحه را تازه کنید و پیش‌نویس همان شعبه را باز کنید." : result.data.message || "ثبت انجام نشد. اطلاعات و دسترسی را بررسی کنید.");
    } else {
      setMessage("نتیجهٔ ثبت مشخص نیست. پیش از تلاش دوباره، فهرست شعبه را بررسی کنید تا کالا تکراری ثبت نشود.");
    }
  }

  if (!ready) return <SectionCardSkeleton rows={4} />;
  return (
    <SectionCard title={industry === "jewelry" ? "ثبت قطعهٔ طلا و جواهر" : "ثبت مدل ساعت"} description={`شعبهٔ ثبت: ${locationName}. پیش‌نویس فقط در همین مرورگر و برای همین کاربر و شعبه ذخیره می‌شود.`}>
      {storageError ? <p role="alert" className="mb-3 text-sm text-destructive">ذخیره‌سازی مرورگر در دسترس نیست؛ پیش‌نویس ممکن است از دست برود.</p> : null}
      {message ? <p role="alert" className="mb-3 text-sm text-destructive">{message}</p> : null}
      {success ? <p role="status" className="mb-3 text-sm">محصول در شعبه ثبت شد.</p> : null}
      {draft.pending && !busy ? <div role="alert" className="mb-4 space-y-2 text-sm"><p>نتیجهٔ ثبت قبلی مشخص نیست. پیش از ثبت دوباره، فهرست شعبهٔ {locationName} را بررسی کنید؛ در صورت تغییر شعبه، ابتدا به همین شعبه برگردید.</p><Link className={buttonVariants({ variant: "outline" })} href="/accounting/products" target="_blank">بررسی فهرست محصولات</Link>{" "}<Button variant="outline" type="button" onClick={() => { persist({ ...draft, pending: false }); setMessage(""); }}>بررسی کردم؛ اجازهٔ تلاش دوباره</Button></div> : null}
      <form onSubmit={submit}>
        <fieldset disabled={busy || draft.pending}>
          <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
            <Field label="نام کالا"><input className={inputClass} maxLength={200} required value={draft.form.name} onChange={(e) => change("name", e.target.value)} /></Field>
            <Field label="کد کالا (اختیاری)"><input className={inputClass} value={draft.form.sku} onChange={(e) => change("sku", e.target.value)} /></Field>
            {industry === "jewelry" ? <>
              <Field label="عیار"><select className={inputClass} value={draft.form.purity} onChange={(e) => change("purity", e.target.value)}>{Object.entries(PURITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="وزن ناخالص (گرم)"><PersianNumberInput className={inputClass} inputMode="decimal" required value={draft.form.grossWeight} onChange={(e) => change("grossWeight", e.target.value)} /></Field>
              <Field label="وزن خالص (گرم)"><PersianNumberInput className={inputClass} inputMode="decimal" required value={draft.form.netWeight} onChange={(e) => change("netWeight", e.target.value)} /></Field>
              <Field label={`بهای هر گرم (${money.unitLabel}، اختیاری)`} hint="بهای خرید قطعه است، نه نرخ روز یا قیمت فروش."><PersianNumberInput className={inputClass} inputMode="decimal" value={draft.form.cost} onChange={(e) => change("cost", e.target.value)} /></Field>
            </> : <>
              <Field label="شماره رفرنس (اختیاری)"><input className={inputClass} value={draft.form.referenceNo} onChange={(e) => change("referenceNo", e.target.value)} /></Field>
              <Field label="نوع موتور"><select className={inputClass} value={draft.form.movement} onChange={(e) => change("movement", e.target.value)}><option value="">تعیین نشده</option>{MOVEMENTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="جنس قاب (اختیاری)"><input className={inputClass} value={draft.form.caseMaterial} onChange={(e) => change("caseMaterial", e.target.value)} /></Field>
              <Field label="قطر قاب (میلی‌متر، اختیاری)"><PersianNumberInput className={inputClass} inputMode="decimal" value={draft.form.caseDiameter} onChange={(e) => change("caseDiameter", e.target.value)} /></Field>
              <Field label="مقاومت در برابر آب (متر، اختیاری)"><PersianNumberInput className={inputClass} inputMode="numeric" value={draft.form.waterResistance} onChange={(e) => change("waterResistance", e.target.value)} /></Field>
              <Field label="رنگ صفحه (اختیاری)"><input className={inputClass} value={draft.form.dialColor} onChange={(e) => change("dialColor", e.target.value)} /></Field>
              <Field label="جنس بند (اختیاری)"><input className={inputClass} value={draft.form.braceletMaterial} onChange={(e) => change("braceletMaterial", e.target.value)} /></Field>
              <Field label="دسته‌بندی جنسیتی"><select className={inputClass} value={draft.form.gender} onChange={(e) => change("gender", e.target.value)}><option value="">تعیین نشده</option>{GENDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="فاصلهٔ سرویس (ماه، اختیاری)"><PersianNumberInput className={inputClass} inputMode="numeric" value={draft.form.serviceInterval} onChange={(e) => change("serviceInterval", e.target.value)} /></Field>
            </>}
          </div>
          <Button type="submit" disabled={busy || draft.pending}>{busy ? "در حال ثبت…" : "ثبت محصول"}</Button>
        </fieldset>
      </form>
    </SectionCard>
  );
}
