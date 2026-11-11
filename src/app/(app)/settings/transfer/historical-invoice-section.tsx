"use client";

import { useEffect, useMemo, useState } from "react";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, inputClass } from "@/app/dashboard/ui";
import { HISTORICAL_INVOICE_FIELDS } from "@/lib/data-transfer/historical-invoice-mapping";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { dataError } from "./data-transfer-ui";

type FieldKey = typeof HISTORICAL_INVOICE_FIELDS[number];
type Mapping = { columns: { field: string; column: number }[] };
type Job = { jobId: string; fileName: string; rowCount: number; status: string; createdAt: string;
  sourceKey: string; provider: string; currency: "rial" | "toman"; calendar: "jalali" | "gregorian";
  columns: string[]; structure: string; lineColumns: string[] | null };
type Summary = Pick<Job, "jobId" | "fileName" | "rowCount" | "createdAt">;
type Document = { externalInvoiceId: string; outcome: string; totalRial: string | null; errors: string[]; warnings: string[];
  rows: { externalCustomerCode?: string }[] };
type Preview = { totalInvoices: number; matchedCustomers: number; reviewNeeded: number; conflicts: number; invalid: number;
  toCreate: number; alreadyImported: number; summaryOnly: number; documents: Document[]; hasMoreDocuments: boolean;
  orphanLineCount: number; hasMoreOrphans: boolean; orphanLines: { externalInvoiceId: string; rowNumber: number; sourceSheet?: string; sourceRowNumber?: number }[];
  reconciliation: { totalRial: string; paidRial: string; balanceRial: string } };
type Review = { externalCustomerCode: string; targetCustomer: { name: string; partyId: string; phoneLast4: string | null }; matchingRows: number;
  sourceNames: string[]; sourcePhones: string[]; rows: { externalInvoiceId: string }[]; evidenceTruncated: boolean; truncated: boolean;
  existingIdentity: { canonicalId: string; canonicalType: string; provider: string; verified: boolean } | null; reviewToken: string };
type Party = { id: string; name: string; phoneLast4: string | null };

const labels: Record<FieldKey, string> = {
  externalInvoiceId: "شناسهٔ فاکتور در مبدأ (الزامی)", invoiceNumber: "شمارهٔ فاکتور", invoiceDate: "تاریخ فاکتور (الزامی)",
  externalCustomerCode: "کد مشتری در مبدأ (الزامی)", sourceCustomerName: "نام مشتری در مبدأ", sourceCustomerPhone: "تلفن مشتری در مبدأ",
  sourceBranch: "شعبهٔ مبدأ", currency: "واحد پول سطر", total: "مبلغ کل (الزامی)", paid: "پرداخت‌شده", balance: "مانده",
  invoiceDiscount: "تخفیف فاکتور", invoiceTax: "مالیات فاکتور", status: "وضعیت مبدأ", paymentDetails: "جزئیات پرداخت", reference: "مرجع",
  lineName: "نام کالا", lineSku: "کد کالا", lineBarcode: "بارکد کالا", quantity: "تعداد", unitPrice: "قیمت واحد", lineDiscount: "تخفیف ردیف", lineTax: "مالیات ردیف",
};
const lineFields: FieldKey[] = ["externalInvoiceId", "lineName", "lineSku", "lineBarcode", "quantity", "unitPrice", "lineDiscount", "lineTax"];
const headerFields = HISTORICAL_INVOICE_FIELDS.filter((field) => field === "externalInvoiceId" || !lineFields.includes(field));
const outcomes: Record<string, string> = { invalid: "نامعتبر", review: "نیازمند بررسی مشتری", ready: "آمادهٔ بررسی نهایی", conflict: "تعارض", already_imported: "قبلاً بایگانی شده" };
const emptyMapping = () => ({} as Partial<Record<FieldKey, number>>);
function asMapping(selection: Partial<Record<FieldKey, number>>): Mapping {
  return { columns: Object.entries(selection).map(([field, column]) => ({ field, column: column! })) };
}
const historicalErrors: Record<string, string> = {
  bad_request: "درخواست یا اطلاعات فایل معتبر نیست.", payload_too_large: "اندازهٔ درخواست بیش از حد مجاز است.",
  invalid_text: "متن فایل حاوی نویسهٔ نامعتبر است.", invalid_utf8: "فایل باید با کدگذاری UTF-8 باشد.",
  invalid_json: "ساختار JSON معتبر نیست.", invalid_json_shape: "فایل JSON باید فهرستی از سطرهای ساده باشد.",
  invalid_csv_quote: "نشانه‌گذاری نقل‌قول در فایل CSV معتبر نیست.", row_wider_than_header: "یک ردیف از تعداد ستون‌های سربرگ بیشتر است.",
  file_too_large: "اندازهٔ فایل بیش از حد مجاز است.", cell_too_long: "یک خانهٔ فایل بیش از حد طولانی است.",
  no_rows: "فایل داده‌ای برای بررسی ندارد.", job_not_editable: "این فایل دیگر قابل بررسی یا ویرایش نیست.",
  duplicate_source_columns: "نام ستون‌ها تکراری است.", invalid_headers: "نام ستون‌ها معتبر نیست.",
  missing_required_fields: "همهٔ ستون‌های الزامی را انتخاب کنید.", invalid_mapping_column: "هر ستون مبدأ را فقط یک بار انتخاب کنید.",
  too_many_rows: "تعداد ردیف‌ها بیش از حد مجاز است.", too_many_cells: "تعداد خانه‌های فایل بیش از حد مجاز است.",
  staged_data_too_large: "حجم دادهٔ آماده‌شده بیش از حد مجاز است.", customer_review_stale: "اطلاعات تغییر کرده است؛ پیوند را دوباره بررسی کنید.",
  customer_not_found: "مشتری فعال در این شعبه یافت نشد.", customer_identity_conflict: "این کد قبلاً به مشتری دیگری پیوند داده شده است.",
  customer_review_evidence_truncated: "اطلاعات هویتی بیش از حد زیاد است و پیوند تأیید نمی‌شود.",
  customer_code_conflict: "کدهای مشتری در ردیف‌های این فاکتور متعارض هستند.",
};
function message(code: unknown) { return historicalErrors[String(code)] ?? dataError(typeof code === "string" ? code : undefined); }
function request(body: unknown, contentType = "application/json") {
  return api<Record<string, unknown>>("/api/data/historical-invoices", { method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(body) });
}

export function HistoricalInvoiceSection() {
  const [history, setHistory] = useState<Summary[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyMore, setHistoryMore] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [provider, setProvider] = useState("");
  const [currency, setCurrency] = useState<"rial" | "toman">("toman");
  const [calendar, setCalendar] = useState<"jalali" | "gregorian">("jalali");
  const [selected, setSelected] = useState<Partial<Record<FieldKey, number>>>(emptyMapping);
  const [selectedLines, setSelectedLines] = useState<Partial<Record<FieldKey, number>>>(emptyMapping);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [offset, setOffset] = useState(0);
  const [orphanOffset, setOrphanOffset] = useState(0);
  const [customerCode, setCustomerCode] = useState("");
  const [search, setSearch] = useState("");
  const [parties, setParties] = useState<Party[]>([]);
  const [party, setParty] = useState<Party | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mapping = useMemo(() => asMapping(selected), [selected]);
  const lineMapping = useMemo(() => asMapping(selectedLines), [selectedLines]);
  const scope = job ? { jobId: job.jobId, sourceKey: job.sourceKey, provider: job.provider, currency: job.currency, calendar: job.calendar,
    mapping, ...(job.structure === "header_lines" ? { lineMapping } : {}) } : null;

  async function loadHistory(nextOffset: number) {
    const result = await request({ action: "list", limit: 20, offset: nextOffset });
    if (!result.ok) { setError(message(result.data.error)); return; }
    setHistory(result.data.jobs as Summary[]); setHistoryMore(result.data.hasMore === true); setHistoryOffset(nextOffset);
  }
  useEffect(() => { void loadHistory(0); }, []);
  function resetReview() { setReview(null); setNotice(""); }
  function resetJob(next: Job) {
    setJob(next); setSelected(emptyMapping()); setSelectedLines(emptyMapping()); setPreview(null); setOffset(0); setOrphanOffset(0);
    setCustomerCode(""); setParty(null); setParties([]); setSearch(""); resetReview();
  }
  async function openJob(jobId: string) {
    setBusy(true); setError("");
    const result = await request({ action: "get", jobId });
    if (result.ok) resetJob(result.data.job as Job); else setError(message(result.data.error));
    setBusy(false);
  }
  async function upload() {
    if (!file || !sourceKey.trim()) { setError("فایل و شناسهٔ ثابت سامانهٔ مبدأ را وارد کنید."); return; }
    const match = /\.(csv|json)$/i.exec(file.name);
    if (!match) { setError("فعلاً فقط فایل CSV یا JSON پذیرفته می‌شود؛ ورود XLSX هنوز فعال نیست."); return; }
    if (file.size > 20 * 1024 * 1024) { setError("اندازهٔ فایل بیش از حد مجاز است."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      const result = await request({ fileName: file.name, format: match[1].toLowerCase(), content, sourceKey, provider, currency, calendar }, "application/vnd.bizamiz.historical-invoice+json");
      if (!result.ok) { setError(message(result.data.error)); return; }
      const staged = result.data.staged as { jobId: string };
      await openJob(staged.jobId); await loadHistory(0);
      setNotice("فایل برای بررسی ذخیره شد؛ هیچ فاکتوری ثبت نشده است.");
    } catch { setError("فایل متنی UTF-8 معتبر نیست یا خواندن آن ممکن نشد."); }
    finally { setBusy(false); }
  }
  async function showPreview(nextOffset = 0, nextOrphanOffset = 0) {
    if (!scope) return;
    setBusy(true); setError(""); resetReview();
    const result = await request({ action: "preview", ...scope, documentOffset: nextOffset, orphanOffset: nextOrphanOffset, sampleLimit: 20 });
    if (result.ok) { setPreview(result.data.preview as Preview); setOffset(nextOffset); setOrphanOffset(nextOrphanOffset); }
    else { setPreview(null); setError(message(result.data.error)); }
    setBusy(false);
  }
  async function findCustomers() {
    if (search.trim().length < 2) return;
    setBusy(true); setError(""); setParty(null); resetReview();
    const result = await request({ action: "search-customer", term: search.trim() });
    if (result.ok) {
      setParties(result.data.customers as Party[]);
      if (result.data.hasMore) setNotice("نتایج بیشتری وجود دارد؛ عبارت دقیق‌تری جست‌وجو کنید.");
      else if ((result.data.customers as Party[]).length === 0) setNotice("مشتری فعالی در این شعبه پیدا نشد.");
    } else setError(message(result.data.error));
    setBusy(false);
  }
  async function reviewCustomer() {
    if (!scope || !party || !customerCode.trim()) return;
    setBusy(true); setError(""); resetReview();
    const result = await request({ action: "review-customer", ...scope, externalCustomerCode: customerCode, partyId: party.id });
    if (result.ok) setReview(result.data.review as Review); else setError(message(result.data.error));
    setBusy(false);
  }
  async function confirmCustomer() {
    if (!scope || !party || !review || review.evidenceTruncated) return;
    setBusy(true); setError("");
    const result = await request({ action: "confirm-customer", ...scope, externalCustomerCode: customerCode, partyId: party.id, reviewToken: review.reviewToken, confirmed: true });
    if (result.ok) { setReview(null); setPreview(null); setNotice("پیوند مشتری با تأیید شما ثبت شد؛ پیش‌نمایش را دوباره بررسی کنید."); }
    else { setReview(null); setError(message(result.data.error)); }
    setBusy(false);
  }
  function mappingFields(fields: readonly FieldKey[], cols: string[], selection: Partial<Record<FieldKey, number>>, change: typeof setSelected) {
    return fields.map((field) => <Field key={field} label={labels[field]}>
      <select className={inputClass} disabled={busy} value={selection[field] ?? ""} onChange={(event) => {
        const value = event.target.value; change((old) => { const next = { ...old }; if (value === "") delete next[field]; else next[field] = Number(value); return next; });
        setPreview(null); resetReview();
      }}><option value="">انتخاب نشده</option>{cols.map((column, index) => <option key={index} value={index}>{column}</option>)}</select>
    </Field>);
  }
  return <div className="space-y-6">
    <SectionCard title="فاکتورهای فروش قدیمی" description="فقط شواهد تاریخی؛ هیچ سفارش، دریافت، موجودی یا سند حسابداری ایجاد نمی‌شود.">
      <InfoBox>اجرای ورود هنوز فعال نیست. این پیش‌نمایش تطبیق میان منابع را بررسی نمی‌کند و تأیید ورود محسوب نمی‌شود. فایل XLSX فعلاً پذیرفته نمی‌شود.</InfoBox>
      {error ? <ErrorBox>{error}</ErrorBox> : null}{notice ? <InfoBox>{notice}</InfoBox> : null}
      <Field label="فایل CSV یا JSON با کدگذاری UTF-8"><input className={inputClass} type="file" accept=".csv,.json" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field>
      <Field label="شناسهٔ ثابت سامانهٔ مبدأ" hint="برای فایل‌های بعدی همان سامانه، همین شناسه را استفاده کنید."><input className={inputClass} value={sourceKey} maxLength={200} disabled={busy} onChange={(event) => setSourceKey(event.target.value)} /></Field>
      <Field label="نام ارائه‌دهندهٔ مبدأ"><input className={inputClass} value={provider} maxLength={200} disabled={busy} onChange={(event) => setProvider(event.target.value)} /></Field>
      <Field label="واحد پول فایل"><select className={inputClass} value={currency} disabled={busy} onChange={(event) => setCurrency(event.target.value as "rial" | "toman")}><option value="toman">تومان</option><option value="rial">ریال</option></select></Field>
      <Field label="تقویم تاریخ‌های فایل"><select className={inputClass} value={calendar} disabled={busy} onChange={(event) => setCalendar(event.target.value as "jalali" | "gregorian")}><option value="jalali">شمسی</option><option value="gregorian">میلادی</option></select></Field>
      <PrimaryButton type="button" disabled={busy} onClick={() => void upload()}>ذخیرهٔ فایل برای بررسی</PrimaryButton>
    </SectionCard>
    <SectionCard title="فایل‌های ذخیره‌شده در این شعبه">
      {history.length === 0 ? <p>فایلی برای نمایش نیست.</p> : <ul className="space-y-2">{history.map((item) => <li key={item.jobId}>
        <SecondaryButton disabled={busy} onClick={() => void openJob(item.jobId)}>{item.fileName} — {toPersianDigits(item.rowCount)} ردیف — {formatJalali(item.createdAt)}</SecondaryButton>
      </li>)}</ul>}
      <div className="mt-4 flex gap-2"><SecondaryButton disabled={busy || historyOffset === 0} onClick={() => void loadHistory(Math.max(0, historyOffset - 20))}>قبلی</SecondaryButton>
        <SecondaryButton disabled={busy || !historyMore} onClick={() => void loadHistory(historyOffset + 20)}>بعدی</SecondaryButton></div>
    </SectionCard>
    {job ? <SectionCard title={`نگاشت ستون‌ها: ${job.fileName}`} description="ستون‌ها را خودتان انتخاب کنید؛ نگاشت خودکار انجام نمی‌شود و پس از خروج باید دوباره انتخاب شود.">
      {mappingFields(job.structure === "header_lines" ? headerFields : HISTORICAL_INVOICE_FIELDS, job.columns, selected, setSelected)}
      {job.structure === "header_lines" && job.lineColumns ? <><h3>ستون‌های ردیف‌ها</h3>{mappingFields(lineFields, job.lineColumns, selectedLines, setSelectedLines)}</> : null}
      <PrimaryButton type="button" disabled={busy} onClick={() => void showPreview()}>پیش‌نمایش بدون ثبت</PrimaryButton>
    </SectionCard> : null}
    {preview ? <SectionCard title="پیش‌نمایش موقت" description="این آمار پس از تطبیق منابع دیگر ممکن است تغییر کند.">
      <p>فاکتورها: {toPersianDigits(preview.totalInvoices)}؛ مشتریان تطبیق‌شده: {toPersianDigits(preview.matchedCustomers)}؛ نیازمند بررسی: {toPersianDigits(preview.reviewNeeded)}؛ نامعتبر: {toPersianDigits(preview.invalid)}؛ تعارض: {toPersianDigits(preview.conflicts)}؛ آمادهٔ بررسی نهایی: {toPersianDigits(preview.toCreate)}؛ قبلاً بایگانی‌شده: {toPersianDigits(preview.alreadyImported)}؛ فقط سربرگ: {toPersianDigits(preview.summaryOnly)}.</p>
      <p>جمع کل: {toPersianDigits(preview.reconciliation.totalRial)} ریال؛ پرداخت: {toPersianDigits(preview.reconciliation.paidRial)} ریال؛ مانده: {toPersianDigits(preview.reconciliation.balanceRial)} ریال.</p>
      <ul className="mt-4 space-y-4">{preview.documents.map((doc, index) => <li key={`${doc.externalInvoiceId}-${index}`}>
        <p>{doc.externalInvoiceId || "بدون شناسه"} — {outcomes[doc.outcome] ?? "نیازمند بررسی"} — {doc.totalRial === null ? "مبلغ نامعتبر" : `${toPersianDigits(doc.totalRial)} ریال`}</p>
        {[...doc.errors, ...doc.warnings].map((message, i) => <p key={i}>{message}</p>)}
        {doc.outcome === "review" && doc.rows.some((row) => row.externalCustomerCode?.trim()) ? <SecondaryButton disabled={busy} onClick={() => { setCustomerCode(doc.rows.find((row) => row.externalCustomerCode?.trim())!.externalCustomerCode!); resetReview(); }}>بررسی مشتری این فاکتور</SecondaryButton> : null}
      </li>)}</ul>
      <div className="mt-4 flex gap-2"><SecondaryButton disabled={busy || offset === 0} onClick={() => void showPreview(Math.max(0, offset - 20), orphanOffset)}>قبلی</SecondaryButton><SecondaryButton disabled={busy || !preview.hasMoreDocuments} onClick={() => void showPreview(offset + 20, orphanOffset)}>بعدی</SecondaryButton></div>
      {preview.orphanLineCount > 0 ? <div className="mt-4"><p>ردیف‌های بدون سربرگ: {toPersianDigits(preview.orphanLineCount)}. این ردیف‌ها به هیچ فاکتوری نسبت داده نشده‌اند.</p>
        <ul>{preview.orphanLines.map((line, index) => <li key={index}>{line.sourceSheet ? `${line.sourceSheet}، ` : ""}ردیف {toPersianDigits(line.sourceRowNumber ?? line.rowNumber)} — شناسهٔ فاکتور: {line.externalInvoiceId || "—"}</li>)}</ul>
        <div className="flex gap-2"><SecondaryButton disabled={busy || orphanOffset === 0} onClick={() => void showPreview(offset, Math.max(0, orphanOffset - 20))}>ردیف‌های قبلی</SecondaryButton><SecondaryButton disabled={busy || !preview.hasMoreOrphans} onClick={() => void showPreview(offset, orphanOffset + 20)}>ردیف‌های بعدی</SecondaryButton></div>
      </div> : null}
    </SectionCard> : null}
    {job && preview ? <SectionCard title="پیوند مشتری موجود" description="نام یا شمارهٔ تلفن فقط راهنمای بررسی است؛ مشتری به‌طور خودکار انتخاب یا ایجاد نمی‌شود.">
      <Field label="کد مشتری در فایل"><input className={inputClass} value={customerCode} disabled={busy} onChange={(event) => { setCustomerCode(event.target.value); resetReview(); }} /></Field>
      <Field label="جست‌وجوی مشتری موجود"><input className={inputClass} value={search} disabled={busy} onChange={(event) => { setSearch(event.target.value); setParty(null); setParties([]); resetReview(); }} /></Field>
      <SecondaryButton disabled={busy || search.trim().length < 2} onClick={() => void findCustomers()}>جست‌وجو</SecondaryButton>
      <ul>{parties.map((item) => <li key={item.id}><SecondaryButton disabled={busy} onClick={() => { setParty(item); resetReview(); }}>{item.name} — {item.phoneLast4 ? `چهار رقم پایانی تلفن: ${toPersianDigits(item.phoneLast4)}` : "چهار رقم پایانی تلفن در دسترس نیست"} — {item.id}</SecondaryButton></li>)}</ul>
      {party ? <p>مشتری انتخاب‌شده: {party.name} — {party.id}</p> : null}
      <SecondaryButton disabled={busy || !party || !customerCode.trim()} onClick={() => void reviewCustomer()}>نمایش جزئیات پیوند</SecondaryButton>
      {review ? <div className="space-y-2"><p>کد مبدأ: {review.externalCustomerCode}؛ مشتری انتخاب‌شده: {review.targetCustomer.name} — {review.targetCustomer.partyId} — {review.targetCustomer.phoneLast4 ? `چهار رقم پایانی تلفن: ${toPersianDigits(review.targetCustomer.phoneLast4)}` : "چهار رقم پایانی تلفن در دسترس نیست"}؛ تعداد ردیف: {toPersianDigits(review.matchingRows)}</p>
        <p>نام‌های مبدأ: {review.sourceNames.join("، ") || "—"}</p><p>تلفن‌های مبدأ: {review.sourcePhones.join("، ") || "—"}</p>
        <p>شناسهٔ فاکتورهای نمونه: {[...new Set(review.rows.map((row) => row.externalInvoiceId).filter(Boolean))].join("، ") || "—"}</p>
        {review.truncated ? <p>فقط نمونه‌ای از ردیف‌ها بررسی شده است؛ نام‌ها و تلفن‌های متمایز در بالا نشان داده می‌شوند.</p> : null}
        {review.existingIdentity ? <p>برای این کد از قبل پیوند وجود دارد؛ تغییر مقصد مجاز نیست.</p> : null}
        {review.evidenceTruncated ? <p>اطلاعات هویتی بیش از حد زیاد است؛ تأیید این پیوند ممکن نیست.</p> : null}
        <PrimaryButton type="button" disabled={busy || review.evidenceTruncated || Boolean(review.existingIdentity && (!review.existingIdentity.verified || review.existingIdentity.provider !== job.provider || review.existingIdentity.canonicalType !== "parties" || review.existingIdentity.canonicalId !== review.targetCustomer.partyId))} onClick={() => void confirmCustomer()}>تأیید پیوند همین مشتری</PrimaryButton>
      </div> : null}
    </SectionCard> : null}
  </div>;
}
