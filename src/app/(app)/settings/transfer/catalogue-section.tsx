"use client";

import { useEffect, useState } from "react";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { SearchField } from "@/app/dashboard/filters";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, inputClass } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { RECONCILIATION_OUTCOME_LABELS, RECONCILIATION_RUN_STATUS_LABELS } from "@/lib/import-reconciliation/types";
import type { CatalogueField, CatalogueMapping, CatalogueRow } from "@/lib/data-transfer/catalogue-profile";
import type { CatalogueRecord } from "@/lib/data-transfer/catalogue-plan";
import type { catalogueItems, catalogueRuns, catalogueSummary } from "@/lib/data-transfer/catalogue-service";
import type { catalogueWooStatus, previewCatalogueWoo } from "@/lib/data-transfer/catalogue-woo";

const url = "/api/data/catalogue";
const labels: Record<CatalogueField, string> = {
  sku: "شناسه کالا", title: "نام محصول", barcode: "بارکد", collection: "مجموعه",
  brand: "برند", case_dimension: "ابعاد قاب", case_material: "جنس قاب", band_material: "جنس بند",
  band_color: "رنگ بند", drive: "نوع موتور", face: "رنگ صفحه", lock_type: "نوع قفل", case_color: "رنگ قاب",
  case_form: "شکل قاب", price: "قیمت (فقط بررسی)", quantity: "موجودی (فقط بررسی)", parent_sku: "شناسه والد",
  parent_title: "نام والد", option: "مقدار محور تنوع",
};
const issueLabels: Record<string, string> = {
  formula: "فرمول قابل تأیید نیست", error: "خطای اکسل", unsafe_number: "عدد خارج از محدوده",
  invalid_identity: "شناسه یا نام نامعتبر", movement_review: "نوع موتور مبهم است و ثبت نمی‌شود",
  dimension_review: "ابعاد نامعتبر است و ثبت نمی‌شود", missing: "بدون مقدار",
  metadata_only: "خارج از ورود اطلاعات این مرحله",
};
const statusLabels: Record<string, string> = {
  proposed: "پیشنهاد", approved: "تأیید شد", held: "نیازمند بررسی", skipped: "رد شد",
  applied: "محلی اعمال شد", failed: "ناموفق", pending: "در صف", processing: "در حال ارسال",
  deferred: "در انتظار", sent: "تأیید ووکامرس", needs_review: "نیازمند بازبینی", dead: "ارسال ناموفق",
};
const wooLabels = { linked: "از قبل پیوند دارد", link: "پیوند به محصول موجود", draft: "ایجاد پیش‌نویس", conflict: "تعارض شناسه یا نوع محصول" };
const errors: Record<string, string> = {
  catalogue_file_limit: "حجم فایل از محدوده مجاز بیشتر است.",
  catalogue_file_invalid: "فایل اکسل خوانده نشد.",
  catalogue_sheet_limit: "برگه باید حداکثر هزار ردیف داده و صد ستون داشته باشد.",
  catalogue_mapping_required: "ستون‌های شناسه کالا و نام محصول را مشخص کنید.",
  catalogue_mapping_invalid: "برای هر فیلد یک ستون یکتا انتخاب کنید.",
  catalogue_variant_group_invalid: "گروه تنوع به والد مشخص، محور معتبر و حداقل دو گزینهٔ یکتا نیاز دارد.",
  active_run_exists: "برای این منبع بررسی فعالی وجود دارد. آن را از فهرست بررسی‌ها باز کنید.",
  preview_stale: "داده‌های شعبه تغییر کرده یا مهلت بررسی گذشته است. بررسی را لغو و دوباره پیش‌نمایش بگیرید.",
  catalogue_woo_preview_changed: "وضعیت فروشگاه تغییر کرده است. دوباره پیش‌نمایش بگیرید.",
  catalogue_local_apply_required: "ابتدا این محصول را در شعبه اعمال کنید.",
  catalogue_woo_existing_family_review: "پیوند خانوادهٔ موجود باید با بررسی تک‌تک تنوع‌ها انجام شود.",
  catalogue_woo_plugin_taxonomy_unavailable: "در این اتصال افزونه‌ای، تطبیق دسته و برند برای پیش‌نویس در دسترس نیست.",
  catalogue_woo_discovery_pending: "درخواست بررسی فقط‌خواندنی در صف افزونه است. پس از اجرای افزونه، دوباره پیش‌نمایش فروشگاه را بگیرید.",
  catalogue_plugin_update_required: "نسخهٔ افزونه از انتشار بازبینی‌شده پشتیبانی نمی‌کند.",
  catalogue_woo_mirror_unverified: "برای ادامه، بررسی نهایی شناسه توسط افزونه را تأیید کنید.",
};

type RunList = Awaited<ReturnType<typeof catalogueRuns>>;
type RunDetails = Awaited<ReturnType<typeof catalogueSummary>> & { items: Awaited<ReturnType<typeof catalogueItems>> };
type LocalItem = RunDetails["items"][number];
type WooPreview = Awaited<ReturnType<typeof previewCatalogueWoo>>;
type Deliveries = Awaited<ReturnType<typeof catalogueWooStatus>>;
type DryRun = { rows: CatalogueRow[]; totals: { rows: number; distinctSkus: number; repeated: number } };
type Overview = { runs: RunList; stores: { id: string; name: string }[]; target: "watch" | "retail"; localOnly: boolean };

async function request<T>(path = "", body?: Record<string, unknown> | FormData): Promise<T> {
  const result = await api<T & { error?: string }>(url + path, body ? {
    method: "POST", body: body instanceof FormData ? body : JSON.stringify(body),
    headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
  } : undefined);
  if (!result.ok) throw new Error(errors[result.data?.error ?? ""] ?? "انجام عملیات ممکن نبود. جزئیات بررسی یا اتصال را کنترل کنید.");
  return result.data;
}

function RowEvidence({ row }: { row: CatalogueRow }) {
  return (
    <details className="min-w-0 text-sm">
      <summary className="cursor-pointer text-muted-foreground">مقادیر فایل و نتیجهٔ تبدیل</summary>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {[...new Set([...Object.keys(row.raw), ...Object.keys(row.values), ...row.issues.map(issue => issue.field)])].map(key => {
          const field = key as CatalogueField;
          const value = row.raw[field];
          const warning = row.issues.find(issue => issue.field === field);
          const normalized = field === "drive" ? row.movement : field === "case_dimension" ? row.dimensions?.join(" × ") : row.values[field];
          return <div key={field} className="min-w-0">
            <dt className="font-medium">{labels[field]}</dt>
            {value ? <dd className="break-words" dir="auto">{value}</dd> : null}
            {warning ? <dd className="text-muted-foreground">{issueLabels[warning.code]}</dd> : null}
            {!warning && normalized && normalized !== value ? <dd dir="auto">{normalized}</dd> : null}
          </div>;
        })}
      </dl>
    </details>
  );
}

export function CatalogueSection() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<CatalogueMapping>({});
  const [omax, setOmax] = useState(false);
  const [axis, setAxis] = useState("");
  const [source, setSource] = useState("catalogue");
  const [dry, setDry] = useState<DryRun | null>(null);
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [run, setRun] = useState<RunDetails | null>(null);
  const [item, setItem] = useState<LocalItem | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [store, setStore] = useState("");
  const [woo, setWoo] = useState<WooPreview | null>(null);
  const [deliveries, setDeliveries] = useState<Deliveries>([]);
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [allowCreate, setAllowCreate] = useState(false);
  const [acceptMirror, setAcceptMirror] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void request<Overview>().then(data => { if (active) setOverview(data); })
      .catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  async function perform(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try { await fn(); } catch (err) {
      setError(err instanceof Error ? err.message : "انجام عملیات ممکن نبود.");
    } finally {
      setBusy(false);
    }
  }

  function upload(action: "analyse" | "preview" | "stage") {
    const body = new FormData();
    if (file) body.append("file", file);
    body.append("options", JSON.stringify({ action, mapping, omax, axis, sourceName: source, duplicateRows: Object.values(chosen) }));
    return body;
  }

  async function loadRun(id: string, selectedItem = item?.id) {
    const data = await request<RunDetails>(`?runId=${id}`);
    setRun(data);
    setItem(data.items.find(row => row.id === selectedItem) ?? null);
  }

  async function deliveryStatus(id: string, connectionId: string) {
    const data = await request<{ deliveries: Deliveries }>(`?runId=${id}&connectionId=${connectionId}`);
    setDeliveries(data.deliveries);
  }

  function resetWoo() {
    setWoo(null);
    setCategory("");
    setBrand("");
    setAllowCreate(false);
    setAcceptMirror(false);
  }

  function changeMapping(next: CatalogueMapping) {
    setMapping(next);
    setDry(null);
    setChosen({});
  }

  const visibleRows = (run
    ? run.items.map(entry => ({ row: (entry.snapshot as CatalogueRecord).catalogue, entry }))
    : (dry?.rows ?? []).map(row => ({ row, entry: null })))
    .filter(({ row }) => `${row.number} ${row.sku ?? ""} ${row.title}`.toLowerCase().includes(search.trim().toLowerCase()));
  const totals = (run?.run.evidence.totals as DryRun["totals"] | undefined) ?? dry?.totals;
  const activeRun = run && ["staged", "in_review", "applying", "partially_applied"].includes(run.run.status);
  const canReview = activeRun && run.run.status !== "applying";
  const saved = overview?.runs.filter(entry => entry.evidence.columns && JSON.stringify(entry.evidence.columns) === JSON.stringify(columns)) ?? [];

  if (!overview && !error) return <LoadingSkeleton />;

  return (
    <div dir="rtl" className="min-w-0 space-y-5">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <SectionCard title="ورود کاتالوگ محصولات از اکسل" description="ابتدا ستون‌ها و ردیف‌های فایل، سپس شناسه‌های شعبه و فروشگاه را بررسی کنید.">
        <InfoBox>این فرایند اطلاعات کاتالوگ را وارد می‌کند. قیمت، بهای خرید، موجودی و شمارهٔ سریال واحدها ثبت نمی‌شوند.</InfoBox>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="فایل اکسل"><input className={inputClass} type="file" accept=".xlsx" disabled={busy || !overview}
            onChange={event => { setFile(event.target.files?.[0] ?? null); setColumns([]); changeMapping({}); setRun(null); setItem(null); resetWoo(); }} /></Field>
          <Field label="باز کردن بررسی قبلی"><select className={inputClass} value={run?.run.id ?? ""} disabled={busy}
            onChange={event => {
              const id = event.target.value;
              setRun(null); setItem(null); setPage(0); setConfirm(false); setDeliveries([]); resetWoo();
              if (id) void perform(() => loadRun(id, 0));
            }}>
            <option value="">انتخاب بررسی</option>
            {overview?.runs.map(entry => <option key={entry.id} value={entry.id}>{entry.evidence.fileName} · {RECONCILIATION_RUN_STATUS_LABELS[entry.status as keyof typeof RECONCILIATION_RUN_STATUS_LABELS]}</option>)}
          </select></Field>
        </div>
        <div className="mt-4">
          <PrimaryButton disabled={!file || busy} onClick={() => void perform(async () => {
            const result = await request<{ columns: string[]; mapping: CatalogueMapping }>("", upload("analyse"));
            setColumns(result.columns); changeMapping(result.mapping); setRun(null);
          })}>خواندن ستون‌ها</PrimaryButton>
        </div>
      </SectionCard>

      {columns.length > 0 && !run ? <SectionCard title="تطبیق ستون‌های فایل">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام ثابت منبع"><input className={inputClass} value={source} maxLength={100} disabled={busy} onChange={e => setSource(e.target.value)} /></Field>
          {saved.length > 0 ? <Field label="تطبیق ذخیره‌شده برای این ستون‌ها"><select className={inputClass} defaultValue="" disabled={busy} onChange={e => {
            const entry = saved.find(candidate => candidate.id === e.target.value);
            if (entry) { changeMapping(entry.evidence.mapping); setSource(entry.evidence.sourceName); }
          }}>
            <option value="">انتخاب تطبیق</option>
            {saved.map(entry => <option key={entry.id} value={entry.id}>{entry.evidence.sourceName} · {entry.evidence.fileName}</option>)}
          </select></Field> : null}
          {(Object.keys(labels) as CatalogueField[]).filter(field => overview?.target !== "watch" || !["parent_sku", "parent_title", "option"].includes(field))
            .map(field => <Field key={field} label={labels[field]}><select className={inputClass} value={mapping[field] ?? ""} disabled={busy} onChange={e => {
              const next = { ...mapping };
              if (e.target.value === "") delete next[field];
              else next[field] = Number(e.target.value);
              changeMapping(next);
            }}>
              <option value="">بدون ستون</option>
              {columns.map((name, index) => <option key={index} value={index}>{name || `ستون ${toPersianDigits(index + 1)}`}</option>)}
            </select></Field>)}
          {overview?.target === "retail" && mapping.option !== undefined ? <Field label="نام محور تنوعِ تعریف‌شده در شعبه">
            <input className={inputClass} value={axis} maxLength={100} disabled={busy} onChange={e => setAxis(e.target.value)} />
          </Field> : null}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={omax} disabled={busy} onChange={e => { setOmax(e.target.checked); setDry(null); }} /> ثبت Omax به‌عنوان برند تأییدشده</label>
        </div>
        <div className="mt-4">
          <PrimaryButton disabled={busy || mapping.sku === undefined || mapping.title === undefined} onClick={() => void perform(async () => {
            setDry(await request<DryRun>("", upload("preview"))); setPage(0); setSearch("");
          })}>پیش‌نمایش ردیف‌ها</PrimaryButton>
        </div>
      </SectionCard> : null}

      {(dry || run) ? <SectionCard title={run ? "بررسی و نتیجهٔ تطبیق شعبه" : "بررسی ردیف‌های اکسل"}>
        <div className="space-y-3">
          {totals ? <p>{toPersianDigits(totals.rows)} ردیف · {toPersianDigits(totals.distinctSkus)} شناسهٔ یکتا · {toPersianDigits(totals.repeated)} تکرار</p> : null}
          {run ? <p aria-live="polite">{RECONCILIATION_RUN_STATUS_LABELS[run.run.status]} · {toPersianDigits(run.counts.applied)} اعمال‌شده · {toPersianDigits(run.counts.failed)} ناموفق</p> : null}
          <SearchField label="جستجوی ردیف، شناسه یا عنوان" value={search} onChange={value => { setSearch(value); setPage(0); }} />
          <ul className="divide-y divide-border">
            {visibleRows.slice(page * 15, page * 15 + 15).map(({ row, entry }) => <li key={row.number} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{toPersianDigits(row.number)} · <bdi>{row.sku || "بدون شناسه"}</bdi></strong>
                <span className="break-words">{row.title}</span>
                {entry ? <StatusBadge>{(entry.snapshot as CatalogueRecord).familyParentRow
                  ? `تنوعِ ردیف ${toPersianDigits((entry.snapshot as CatalogueRecord).familyParentRow!)}`
                  : `${RECONCILIATION_OUTCOME_LABELS[entry.outcome]} · ${statusLabels[entry.status]}`}</StatusBadge> : null}
              </div>
              {row.duplicateRows.length > 0 ? <p className="text-sm text-muted-foreground">شناسهٔ تکراری در ردیف‌های {row.duplicateRows.map(toPersianDigits).join("، ")}</p> : null}
              <RowEvidence row={row} />
              {!run && row.sku && row.duplicateRows.length > 0 ? <label className="flex items-center gap-2 text-sm">
                <input type="radio" name={`duplicate-${row.sku}`} checked={chosen[row.sku] === row.number} onChange={() => setChosen(previous => ({ ...previous, [row.sku!]: row.number }))} /> انتخاب این ردیف برای شناسه
              </label> : null}
              {entry && entry.status !== "skipped" ? <SecondaryButton disabled={busy} onClick={() => { setItem(entry); resetWoo(); }}>بررسی این محصول</SecondaryButton> : null}
            </li>)}
          </ul>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton disabled={page === 0} onClick={() => setPage(page - 1)}>صفحهٔ قبل</SecondaryButton>
            <SecondaryButton disabled={(page + 1) * 15 >= visibleRows.length} onClick={() => setPage(page + 1)}>صفحهٔ بعد</SecondaryButton>
          </div>
          {!run ? <PrimaryButton disabled={busy} onClick={() => void perform(async () => {
            const { runId } = await request<{ runId: string }>("", upload("stage"));
            setOverview(await request<Overview>()); setPage(0); await loadRun(runId, 0);
          })}>آماده‌سازی بررسی شعبه</PrimaryButton> :
            <a className="text-primary underline" href={`${url}?runId=${run.run.id}&report=csv`}>دانلود گزارش ردیف‌ها</a>}
        </div>
      </SectionCard> : null}

      {run && item ? <SectionCard title={`بررسی ${(item.snapshot as CatalogueRecord).catalogue.title}`}>
        <div className="space-y-3">
          {item.candidates.map(candidate => <div key={candidate.id} className="flex flex-wrap items-center gap-2">
            <span>{candidate.label}</span>
            {canReview && item.status !== "applied" ? <SecondaryButton disabled={busy} onClick={() => void perform(async () => {
              await request("", { action: "review", runId: run.run.id, itemId: item.id, decision: "link", canonicalId: candidate.id });
              await loadRun(run.run.id);
            })}>تأیید پیوند</SecondaryButton> : null}
          </div>)}
          {item.error ? <ErrorBox>{item.error}</ErrorBox> : null}
          {canReview && item.status !== "applied" ? <div className="flex flex-wrap gap-2">
            {(item.outcome === "create_new" ? [["create_separate", "تأیید ایجاد"], ["skip", "رد ردیف"], ["keep_for_review", "نگه‌داشتن برای بررسی"]] :
              [["skip", "رد ردیف"], ["keep_for_review", "نگه‌داشتن برای بررسی"]]).map(([decision, label]) =>
              <SecondaryButton key={decision} disabled={busy} onClick={() => void perform(async () => {
                await request("", { action: "review", runId: run.run.id, itemId: item.id, decision });
                await loadRun(run.run.id);
              })}>{label}</SecondaryButton>)}
          </div> : null}
          {overview?.stores.length ? <Field label="فروشگاه ووکامرس"><select className={inputClass} value={store} disabled={busy} onChange={event => {
            const id = event.target.value;
            setStore(id); resetWoo(); setDeliveries([]);
            if (id) void perform(() => deliveryStatus(run.run.id, id));
          }}>
            <option value="">انتخاب فروشگاه</option>
            {overview.stores.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select></Field> : <InfoBox>{overview?.localOnly ? "در حالت آفلاین فقط بررسی و اعمال محلی در دسترس است." : "فروشگاه قابل دسترسی برای این شعبه پیدا نشد."}</InfoBox>}
          {store && item.outcome !== "invalid" ? <SecondaryButton disabled={busy} onClick={() => void perform(async () => {
            resetWoo();
            const data = await request<{ preview: WooPreview }>("", { action: "woo-preview", runId: run.run.id, itemId: item.id, connectionId: store });
            setWoo(data.preview);
            if (data.preview.category.choices.length === 1) setCategory(String(data.preview.category.choices[0].id));
            if (data.preview.brand.choices.length === 1) setBrand(String(data.preview.brand.choices[0].id));
          })}>پیش‌نمایش فروشگاه</SecondaryButton> : null}
          {woo ? <>
            <p>{wooLabels[woo.action]}{woo.remote ? <> · <bdi>{woo.remote.name} #{woo.remote.id}</bdi></> : null}</p>
            {woo.matches.length > 1 ? <ul>{woo.matches.map(remote => <li key={remote.id}><bdi>{remote.name} #{remote.id} · {remote.type}</bdi></li>)}</ul> : null}
            {woo.variations.length > 0 ? <ul className="text-sm">{woo.variations.map(variation => <li key={variation.id}>
              <bdi>{variation.remoteSku} #{variation.id}</bdi> · {variation.options.map(option => option.option).join("، ")}
            </li>)}</ul> : null}
            {woo.discovery === "mirror" ? <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={acceptMirror} onChange={e => setAcceptMirror(e.target.checked)} />
              پیش‌نمایش از داده‌های همگام‌شده است. شناسه در فروشگاه هنگام ارسال بررسی می‌شود.
            </label> : null}
            {woo.category.value ? <p>مجموعهٔ فایل {woo.category.value} · {woo.category.choices.map(choice => `${choice.name} (#${choice.id})`).join("، ") || "بدون دستهٔ هم‌نام"}</p> : null}
            {woo.brand.value ? <p>برند فایل {woo.brand.value} · {woo.brand.choices.map(choice => `${choice.name} (#${choice.id})`).join("، ") || "بدون برند هم‌نام"}</p> : null}
            {woo.attributes.length ? <ul className="text-sm">{woo.attributes.map(attribute => <li key={attribute.field}>
              {labels[attribute.field as CatalogueField]} · {attribute.value} · {attribute.term ? `${attribute.term.name} (#${attribute.term.id})` : attribute.conflict ? "تعارض در فروشگاه" : "بدون مقدار هم‌نام"}
            </li>)}</ul> : null}
            {woo.action === "draft" && woo.discovery === "live" ? <>
              {woo.category.choices.length > 0 ? <Field label="دستهٔ پیش‌نویس"><select className={inputClass} value={category} onChange={e => setCategory(e.target.value)}>
                <option value="">بدون دسته</option>
                {woo.category.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name} #{choice.id}</option>)}
              </select></Field> : null}
              {woo.brand.choices.length > 0 ? <Field label="برند پیش‌نویس"><select className={inputClass} value={brand} onChange={e => setBrand(e.target.value)}>
                <option value="">بدون برند</option>
                {woo.brand.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name} #{choice.id}</option>)}
              </select></Field> : null}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowCreate} onChange={e => setAllowCreate(e.target.checked)} /> ایجاد دسته و ویژگی‌های بدون معادل را تأیید می‌کنم.</label>
            </> : null}
            {["draft", "link"].includes(woo.action) ? <PrimaryButton disabled={busy || !item.resolvedCanonicalId || (woo.discovery === "mirror" && !acceptMirror)}
              onClick={() => void perform(async () => {
                await request("", { action: "woo-queue", runId: run.run.id, itemId: item.id, connectionId: store, token: woo.token,
                  ...(category && woo.discovery === "live" ? { categoryId: Number(category) } : {}),
                  ...(brand && woo.discovery === "live" ? { brandId: Number(brand) } : {}),
                  createMissing: allowCreate, acceptMirror });
                await deliveryStatus(run.run.id, store);
              })}>تأیید و ارسال به صف ووکامرس</PrimaryButton> : null}
          </> : null}
          {store ? <SecondaryButton disabled={busy} onClick={() => void perform(() => deliveryStatus(run.run.id, store))}>به‌روزرسانی وضعیت ارسال</SecondaryButton> : null}
          {deliveries.length ? <ul aria-live="polite" className="space-y-2 text-sm">
            {deliveries.map(delivery => <li key={delivery.operation}>
              {statusLabels[delivery.status] ?? delivery.status} {delivery.remote ? <bdi>#{delivery.remote}</bdi> : null}
              {delivery.expected_children ? <> · {toPersianDigits(delivery.expected_children)} تنوع در انتظار نتیجهٔ مستقل</> : null}
              {delivery.error ? <span dir="auto"> · {delivery.error}</span> : null}
            </li>)}
          </ul> : null}
        </div>
      </SectionCard> : null}

      {run && (activeRun || run.run.status === "stale") ? <SectionCard title="اعمال تغییرات شعبه">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />
          اعمال اطلاعات کاتالوگ بدون قیمت و موجودی را تأیید می‌کنم.
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <PrimaryButton disabled={busy || !confirm || !activeRun} onClick={() => void perform(async () => {
            let status: string;
            do {
              const data = await request<{ run: { status: string } }>("", { action: "apply", runId: run.run.id, confirmMetadataOnly: true, approveSafe: true });
              status = data.run.status;
              await loadRun(run.run.id);
            } while (status === "applying");
          })}>اعمال موارد تأییدشده و بدون تعارض</PrimaryButton>
          {run.run.status !== "applying" ? <SecondaryButton disabled={busy} onClick={() => void perform(async () => {
            await request("", { action: "cancel", runId: run.run.id }); await loadRun(run.run.id); setOverview(await request<Overview>());
          })}>لغو بررسی</SecondaryButton> : null}
        </div>
      </SectionCard> : null}
    </div>
  );
}
