"use client";

import { useEffect, useState } from "react";
import { SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import {
  RECONCILIATION_DECISION_LABELS, RECONCILIATION_OUTCOME_LABELS, RECONCILIATION_RUN_STATUS_LABELS, allowedDecisions,
  type IncomingProduct, type ReconciliationDecision,
} from "@/lib/import-reconciliation/types";
import type { cataloguePage } from "@/lib/data-transfer/catalogue-import-service";
import type { catalogueWooReview, catalogueWooStatus } from "@/lib/data-transfer/catalogue-woo-service";
import type { CatalogueField, CatalogueMapping } from "@/lib/data-transfer/catalogue-workbook";

const endpoint = "/api/data/catalogue";
type Page = Awaited<ReturnType<typeof cataloguePage>>;
type Item = Page["items"][number];
type WooReview = Awaited<ReturnType<typeof catalogueWooReview>>;
type WooOperations = Awaited<ReturnType<typeof catalogueWooStatus>>;
type Workbook = { columns: string[]; suggested: CatalogueMapping; rows: number; worksheet: string };
type Configuration = {
  target: string;
  fields: CatalogueField[];
  stores: Array<{ id: string; name: string }>;
  runs: Array<{ id: string; file_name: string; status: string }>;
};

const labels: Record<CatalogueField, string> = {
  sku: "کد کالا", title: "نام کالا", brand: "برند", collection: "مجموعه",
  case_dimension: "ابعاد قاب", case_material: "جنس قاب", band_material: "جنس بند",
  band_color: "رنگ بند", drive: "نوع موتور", face: "رنگ صفحه", lock_type: "نوع قفل",
  case_color: "رنگ قاب", case_form: "شکل قاب", price: "قیمت (فقط بررسی)", quantity: "موجودی (فقط بررسی)",
  parent_sku: "کد محصول والد", parent_title: "نام محصول والد", option_name: "نام گزینهٔ تنوع", option_value: "مقدار گزینهٔ تنوع",
};

async function request<T>(url: string, init?: RequestInit) {
  const result = await api<T & { error?: string }>(url, init);
  if (!result.ok) throw new Error(result.data?.error ?? "catalogue_request_failed");
  return result.data;
}

function action<T>(runId: string, payload: Record<string, unknown>) {
  return request<T>(endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, ...payload }),
  });
}

function warningLabel(warning: string) {
  const [field, code] = warning.split(":");
  const name = labels[field as CatalogueField] ?? field;
  const detail = code === "formula_or_error" ? "فرمول یا خطای اکسل، مقدار نامعتبر برای ورود"
    : code === "review_required" ? "مقدار مبهم، نیازمند بررسی"
    : code === "diameter_unknown" ? "قطر از این ابعاد قابل تشخیص نیست"
    : "در این ورود ثبت نمی‌شود";
  return `${name} — ${detail}`;
}

export function CatalogueImportWizard() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Configuration | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [mapping, setMapping] = useState<CatalogueMapping>({});
  const [source, setSource] = useState("");
  const [brand, setBrand] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [search, setSearch] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wooItem, setWooItem] = useState<Item | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [woo, setWoo] = useState<WooReview | null>(null);
  const [remoteId, setRemoteId] = useState("");
  const [includeTaxonomy, setIncludeTaxonomy] = useState(false);
  const [createTaxonomy, setCreateTaxonomy] = useState(false);
  const [remoteAction, setRemoteAction] = useState<"link" | "link_parent" | "create" | "create_parent">("link");
  const linking = remoteAction === "link" || remoteAction === "link_parent";
  const [operations, setOperations] = useState<WooOperations>([]);

  const refreshConfig = () => request<Configuration>(endpoint).then(setConfig);
  useEffect(() => { void refreshConfig().catch(() => {}).finally(() => setLoading(false)); }, []);

  async function work(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await task(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "catalogue_request_failed"); }
    finally { setBusy(false); }
  }

  async function openRun(id: string, query = "", after = 0) {
    const params = new URLSearchParams({ run: id, search: query, after: String(after) });
    setPage(await request<Page>(`${endpoint}?${params}`));
  }

  function resetWoo() {
    setWoo(null);
    setRemoteId("");
    setOperations([]);
  }

  async function upload(stage: boolean) {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    if (!stage) {
      const analysed = await request<Workbook>(endpoint, { method: "POST", body: form });
      setWorkbook(analysed);
      setMapping(analysed.suggested);
      return;
    }
    form.set("action", "stage");
    form.set("source", source);
    form.set("brand", brand);
    form.set("mapping", JSON.stringify(mapping));
    const staged = await request<{ runId: string }>(endpoint, { method: "POST", body: form });
    await openRun(staged.runId);
    await refreshConfig();
  }

  async function localAction(payload: Record<string, unknown>) {
    if (!page) return;
    await action(page.run.id, payload);
    await openRun(page.run.id, search);
  }

  async function reviewWoo(phase: "discover" | "preview" | "queue") {
    if (!page || !wooItem) return;
    const result = await action<WooReview>(page.run.id, {
      action: "woo", itemId: wooItem.id, connectionId, includeTaxonomy, createTaxonomy,
      ...(phase === "discover" ? {} : { remoteAction, remoteId: linking ? remoteId || undefined : undefined }),
      ...(phase === "queue" && woo?.preview ? { reviewToken: woo.preview.reviewToken } : {}),
    });
    setWoo(result);
    if (phase === "queue") await refreshWooStatus();
  }

  async function refreshWooStatus() {
    if (!page || !connectionId) return;
    const result = await action<{ operations: WooOperations }>(page.run.id, { action: "woo_status", connectionId });
    setOperations(result.operations);
  }

  if (loading) return <SectionCardSkeleton />;
  if (!config) return null;
  const counts = page?.run.evidence.counts as { rows: number; uniqueSkus: number; repeated: number } | undefined;
  const duplicates = page?.run.evidence.duplicateRows as [string, number[]][] | undefined;
  const reviewable = page && ["staged", "in_review", "partially_applied"].includes(page.run.status);
  return (
    <div id="catalogue-import" dir="rtl" className="space-y-4">
      <SectionCard title="ورود کاتالوگ محصولات از اکسل"
        description={config.target === "watch" ? "مدل ساعت و مشخصات آن را بررسی کنید. دستگاه یا سریال انبار از اکسل ایجاد نمی‌شود." : "کالاهای موجود و تنوع‌های دارای والد و گزینهٔ صریح را بررسی کنید."}>
        <div className="space-y-3">
          {error && <ErrorBox>{error}</ErrorBox>}
          <Field label="فایل اکسل">
            <input type="file" accept=".xlsx" className={inputClass} disabled={busy}
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setWorkbook(null); }} />
          </Field>
          <SecondaryButton disabled={!file || busy} onClick={() => void work(() => upload(false))}>بررسی فایل و ستون‌ها</SecondaryButton>
          {config.runs.length > 0 && (
            <Field label="ادامهٔ بررسی قبلی">
              <select className={inputClass} value={page?.run.id ?? ""} disabled={busy} onChange={(event) => {
                const id = event.target.value;
                setConfirmed(false); setSearch(""); setWooItem(null); resetWoo();
                if (id) void work(() => openRun(id)); else setPage(null);
              }}>
                <option value="">انتخاب بررسی</option>
                {config.runs.map((run) => <option key={run.id} value={run.id}>{run.file_name} — {RECONCILIATION_RUN_STATUS_LABELS[run.status as Page["run"]["status"]]}</option>)}
              </select>
            </Field>
          )}
          {workbook && (
            <>
              <InfoBox>برگهٔ {workbook.worksheet}، {toPersianDigits(workbook.rows)} ردیف. قیمت و موجودی فقط در گزارش بررسی می‌شوند.</InfoBox>
              <Field label="نام ثابت منبع برای ورودهای بعدی">
                <input className={inputClass} maxLength={120} value={source} onChange={(event) => setSource(event.target.value)} />
              </Field>
              {page && <SecondaryButton disabled={busy} onClick={() => {
                const previousColumns = page.run.evidence.columns as string[];
                if (JSON.stringify(previousColumns) !== JSON.stringify(workbook.columns)) {
                  setError("ستون‌های این فایل با نگاشت ذخیره‌شده یکسان نیستند.");
                  return;
                }
                setMapping(page.run.evidence.mapping as CatalogueMapping);
                setSource(String(page.run.evidence.sourceName ?? ""));
                setBrand(String(page.run.evidence.fixedBrand ?? ""));
              }}>استفاده از نگاشت بررسی قبلی</SecondaryButton>}
              <Field label="برند ثابت (اختیاری)">
                <input className={inputClass} maxLength={120} value={brand} onChange={(event) => setBrand(event.target.value)} />
              </Field>
              <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
                {config.fields.map((field) => (
                  <Field key={field} label={labels[field]}>
                    <select className={inputClass} value={mapping[field] ?? ""} onChange={(event) => {
                      const column = event.target.value;
                      setMapping((previous) => {
                        const next = { ...previous };
                        if (column === "") delete next[field]; else next[field] = Number(column);
                        return next;
                      });
                    }}>
                      <option value="">بدون نگاشت</option>
                      {workbook.columns.map((column, index) => <option value={index} key={index}>{column || "ستون بدون عنوان"} ({toPersianDigits(index + 1)})</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <PrimaryButton type="button" disabled={busy || mapping.sku == null || mapping.title == null || !source.trim()}
                onClick={() => void work(async () => { setConfirmed(false); setSearch(""); setWooItem(null); resetWoo(); await upload(true); })}>ساخت پیش‌نمایش و بررسی تطبیق محلی</PrimaryButton>
            </>
          )}
        </div>
      </SectionCard>

      {page && counts && (
        <SectionCard title="پیش‌نمایش و تصمیم‌های محلی" description={RECONCILIATION_RUN_STATUS_LABELS[page.run.status]}>
          <div className="space-y-3">
            <InfoBox>{toPersianDigits(counts.rows)} ردیف، {toPersianDigits(counts.uniqueSkus)} کد یکتا، {toPersianDigits(counts.repeated)} تکرار، {toPersianDigits(page.counts.applied)} اعمال‌شده، {toPersianDigits(page.counts.failed)} ناموفق، {toPersianDigits(page.counts.pending)} در انتظار بررسی</InfoBox>
            {!!duplicates?.length && <details><summary>شمارهٔ ردیف‌های تکراری در اکسل</summary>
              <ul>{duplicates.map(([sku, rows]) => <li key={sku}><bdi>{sku}</bdi> — {rows.map(toPersianDigits).join("، ")}</li>)}</ul>
            </details>}
            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void work(() => openRun(page.run.id, search)); }}>
              <Field label="جست‌وجوی نام یا کد کالا"><input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
              <SecondaryButton type="submit" disabled={busy}>جست‌وجو</SecondaryButton>
            </form>
            <a className="text-primary underline" href={`${endpoint}?run=${page.run.id}&report=csv`}>دریافت گزارش ردیف‌ها</a>
            <ul className="divide-y divide-border">
              {page.items.map((item) => (
                <CatalogueRow key={item.id} item={item} columns={page.run.evidence.columns as string[]}
                  disabled={busy || !reviewable} canReviewWoo={config.stores.length > 0}
                  onWoo={() => { setWooItem(item); resetWoo(); }}
                  onDecision={(decision, canonicalId, reason) => void work(() =>
                    localAction({ action: "decide", itemId: item.id, decision, canonicalId, reason }))} />
              ))}
            </ul>
            {page.items.length === 25 && <SecondaryButton disabled={busy}
              onClick={() => void work(() => openRun(page.run.id, search, page.items.at(-1)?.id))}>ردیف‌های بعدی</SecondaryButton>}
            {reviewable && (
              <>
                <div className="flex flex-wrap gap-2">
                  <SecondaryButton disabled={busy} onClick={() => void work(() => localAction({ action: "approve_safe" }))}>تأیید موارد بدون تعارض</SecondaryButton>
                  <SecondaryButton disabled={busy} onClick={() => void work(() => localAction({ action: "cancel" }))}>پایان بررسی</SecondaryButton>
                </div>
                <Field label="ورود فقط مشخصات و پیوندهای تأییدشده را می‌پذیرم. قیمت و موجودی فایل ثبت نمی‌شوند.">
                  <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                </Field>
                <PrimaryButton type="button" disabled={busy || !confirmed}
                  onClick={() => void work(() => localAction({ action: "apply", confirmMetadata: true }))}>اعمال موارد تأییدشده</PrimaryButton>
              </>
            )}
            {page.run.status === "stale" && <SecondaryButton disabled={busy}
              onClick={() => void work(() => localAction({ action: "cancel" }))}>بستن پیش‌نمایش منقضی و ساخت بررسی تازه</SecondaryButton>}
          </div>
        </SectionCard>
      )}

      {page && wooItem && (
        <SectionCard title="تطبیق ووکامرس" description={String((wooItem.snapshot as IncomingProduct).sku ?? "")}>
          <div className="space-y-3">
            <Field label="فروشگاه">
              <select className={inputClass} value={connectionId} disabled={busy} onChange={(event) => { setConnectionId(event.target.value); resetWoo(); }}>
                <option value="">انتخاب فروشگاه</option>
                {config.stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}
              </select>
            </Field>
            <SecondaryButton disabled={busy || !connectionId} onClick={() => void work(() => reviewWoo("discover"))}>جست‌وجوی کالا و طبقه‌بندی</SecondaryButton>
            {woo && (
              <>
                {!woo.readable && <InfoBox>این اتصال فهرست زندهٔ محصولات ارائه نمی‌دهد. شناسهٔ انتخابی هنگام پاسخ افزونه بررسی می‌شود.</InfoBox>}
                {woo.candidates.map((candidate) => <p key={candidate.id}>{candidate.name} — <bdi>{candidate.sku} · #{candidate.id}</bdi></p>)}
                {woo.mapped.map((existing) => <p key={existing.remote_id}>پیوند موجود — <bdi>#{existing.remote_id}</bdi></p>)}
                <details><summary>پیشنهادهای دسته، برند و ویژگی‌های فروشگاه</summary>
                  <ul>
                    {woo.categories.map((term) => <li key={term.remoteId}>دسته — {term.name} · <bdi>{term.slug} #{term.remoteId}</bdi></li>)}
                    {woo.brands.map((term) => <li key={term.remoteId}>برند — {term.name} · <bdi>{term.slug} #{term.remoteId}</bdi></li>)}
                    {woo.attributeTerms.map((term) => <li key={term.field}>{labels[term.field as CatalogueField]} — {term.value} · {term.matches.map((entry) => `#${entry.remoteId}`).join("، ") || "بدون تطبیق"}</li>)}
                  </ul>
                </details>
                <Field label="اقدام برای این فروشگاه">
                  <select className={inputClass} value={remoteAction} onChange={(event) => {
                    setRemoteAction(event.target.value as typeof remoteAction);
                    setWoo((previous) => previous ? { ...previous, preview: undefined } : previous);
                  }}>
                    <option value="link">پیوند به محصول موجود</option>
                    <option value="create">ساخت پیش‌نویس جدید</option>
                    {woo.parentSku && !woo.remoteParent && <>
                      <option value="link_parent">پیوند به والد موجود</option>
                      <option value="create_parent">ساخت پیش‌نویس والد</option>
                    </>}
                  </select>
                </Field>
                {linking ? (
                  <Field label="شناسهٔ محصول یا تنوع در فروشگاه">
                    <input dir="ltr" inputMode="numeric" className={inputClass} value={remoteId} onChange={(event) => { setRemoteId(event.target.value); setWoo({ ...woo, preview: undefined }); }} />
                  </Field>
                ) : woo.readable && !woo.parentSku && (
                  <>
                    <Field label="افزودن دسته و ویژگی‌های یکتای تأییدشده به پیش‌نویس">
                      <input type="checkbox" checked={includeTaxonomy} onChange={(event) => { setIncludeTaxonomy(event.target.checked); setCreateTaxonomy(false); setWoo({ ...woo, preview: undefined }); }} />
                    </Field>
                    {includeTaxonomy && <Field label="اجازهٔ ساخت دسته یا ویژگی و مقدارِ پیدا نشده">
                      <input type="checkbox" checked={createTaxonomy} onChange={(event) => { setCreateTaxonomy(event.target.checked); setWoo({ ...woo, preview: undefined }); }} />
                    </Field>}
                  </>
                )}
                <SecondaryButton disabled={busy || !page.run.crossChecked || (linking && !remoteId.trim())}
                  onClick={() => void work(() => reviewWoo("preview"))}>پیش‌نمایش اقدام ووکامرس</SecondaryButton>
                {"preview" in woo && woo.preview && (
                  <div className="space-y-2">
                    <p>{woo.preview.storeName} — {woo.preview.name} — {linking ? "پیوند" : "پیش‌نویس"}</p>
                    {woo.preview.payload.__catalogueTaxonomy != null && <details open><summary>تغییرهای دسته و ویژگی‌ها</summary>
                      <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(woo.preview.payload.__catalogueTaxonomy, null, 2)}</pre>
                    </details>}
                    <PrimaryButton type="button" disabled={busy || woo.queued}
                      onClick={() => void work(() => reviewWoo("queue"))}>{woo.queued ? "در صف ارسال" : "تأیید و ارسال به صف"}</PrimaryButton>
                  </div>
                )}
              </>
            )}
            <SecondaryButton disabled={busy || !connectionId} onClick={() => void work(refreshWooStatus)}>به‌روزرسانی وضعیت ارسال</SecondaryButton>
            {operations.map((operation) => <p key={operation.id} className="break-all">
              {operation.status === "sent" && operation.ack ? `تأیید فروشگاه #${operation.ack}` : operation.status} {operation.last_error ?? ""}
            </p>)}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function CatalogueRow({ item, columns, disabled, canReviewWoo, onDecision, onWoo }: {
  item: Item;
  columns: string[];
  disabled: boolean;
  canReviewWoo: boolean;
  onDecision: (decision: ReconciliationDecision, canonicalId: string, reason: string) => void;
  onWoo: () => void;
}) {
  const record = item.snapshot as IncomingProduct;
  const [decision, setDecision] = useState<ReconciliationDecision | "">("");
  const [canonicalId, setCanonicalId] = useState(item.canonicalId ?? "");
  const [reason, setReason] = useState("");
  const fields = record.fields as { source: string[]; warnings: string[]; errors: string[]; specs: Record<string, string> };
  const options = allowedDecisions(item.outcome, Boolean(item.candidates.length))
    .filter((choice) => choice !== "choose_authority" && (choice !== "create_separate" || !item.candidates.length));
  return (
    <li className="space-y-2 py-3">
      <p>{toPersianDigits(item.rowNumber ?? 0)} — {record.name} — <bdi>{record.sku}</bdi></p>
      <p>{RECONCILIATION_OUTCOME_LABELS[item.outcome]} · {item.status}</p>
      {fields.warnings.map((warning) => <p key={warning} className="text-sm text-muted-foreground">{warningLabel(warning)}</p>)}
      {item.error && <ErrorBox>{item.error}</ErrorBox>}
      <details>
        <summary>مقادیر اصلی، مشخصات و گزینه‌های تطبیق</summary>
        <dl className="grid gap-2 sm:grid-cols-2">
          {columns.map((column, index) => <div className="min-w-0 break-words" key={index}><dt>{column}</dt><dd><bdi>{fields.source[index]}</bdi></dd></div>)}
          {Object.entries(fields.specs).map(([key, value]) => <div key={key}><dt>{labels[key as CatalogueField]}</dt><dd>{value}</dd></div>)}
        </dl>
        {item.candidates.map((candidate) => <p key={candidate.id}>{candidate.label} · <bdi>{candidate.id}</bdi></p>)}
      </details>
      {!disabled && item.status !== "applied" && (
        <div className="space-y-2">
          <Field label="تصمیم این ردیف">
            <select className={inputClass} value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}>
              <option value="">انتخاب</option>
              {options.map((option) => <option value={option} key={option}>{RECONCILIATION_DECISION_LABELS[option]}</option>)}
            </select>
          </Field>
          {decision === "link" && <Field label="کالای موجود">
            <select className={inputClass} value={canonicalId} onChange={(event) => setCanonicalId(event.target.value)}>
              <option value="">انتخاب کالا</option>
              {item.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </Field>}
          {decision === "create_separate" && item.outcome === "ambiguous" &&
            <Field label="دلیل انتخاب این ردیف"><input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>}
          <SecondaryButton disabled={!decision || (decision === "link" && !canonicalId) ||
            (decision === "create_separate" && item.outcome === "ambiguous" && !reason.trim())}
            onClick={() => { if (decision) onDecision(decision, canonicalId, reason); }}>ذخیرهٔ تصمیم</SecondaryButton>
        </div>
      )}
      {canReviewWoo && record.sku && <SecondaryButton onClick={onWoo}>بررسی در ووکامرس</SecondaryButton>}
    </li>
  );
}
