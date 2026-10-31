"use client";
import { useEffect, useState } from "react";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import { Button } from "@/components/ui/button";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "../ui";

interface Store { id: string; name: string }
interface Mapping { connection_id: string; definition_id: string; taxonomy: string; terms: Record<string, { name: string; slug: string }> }
export function WooAttributeMapping() {
  const [stores, setStores] = useState<Store[]>([]);
  const [definitions, setDefinitions] = useState<AttributeDefinition[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [storeId, setStoreId] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [slug, setSlug] = useState("");
  const [terms, setTerms] = useState<{ local: string; name: string; slug: string }[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    setLoading(true); setError("");
    const [settings, attrs] = await Promise.all([
      api<{ connections?: Store[]; mappings?: Mapping[] }>("/api/products/attributes/woo"),
      api<{ definitions?: AttributeDefinition[] }>("/api/products/attributes"),
    ]);
    setLoading(false);
    if (settings.status === 403) return;
    if (!settings.ok || !attrs.ok) { setError("اطلاعات نگاشت فروشگاه بارگیری نشد."); return; }
    setStores(settings.data.connections ?? []); setMappings(settings.data.mappings ?? []);
    setDefinitions((attrs.data.definitions ?? []).filter(d => d.isActive));
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const definition = definitions.find(d => d.id === definitionId);
    const mapping = mappings.find(m => m.connection_id === storeId && m.definition_id === definitionId);
    setSlug(mapping?.taxonomy.replace(/^pa_/, "") ?? "");
    setTerms((definition?.options ?? []).map(local => ({ local, name: mapping?.terms[local]?.name ?? local, slug: mapping?.terms[local]?.slug ?? "" })));
    setReviewed(false); setNotice("");
  }, [definitionId, storeId, definitions, mappings]);
  if (loading) return <SectionCardSkeleton rows={2} />;
  if (!stores.length && !error) return null;
  const definition = definitions.find(d => d.id === definitionId);
  return <SectionCard title="نگاشت ویژگی به فروشگاه">
    <InfoBox>ویژگی و مقدارهای حسابداری را برای هر فروشگاه بررسی کنید. شناسه‌های فروشگاه پس از پاسخ موفق ثبت می‌شوند. ویژگی یا مقدارِ دارای نامک موجود دوباره استفاده می‌شود؛ نامک جدید در فروشگاه ساخته می‌شود.</InfoBox>
    <ErrorBox>{error}</ErrorBox>
    {notice ? <p role="status">{notice}</p> : null}
    {!stores.length ? <Button variant="outline" onClick={() => void load()}>تلاش دوباره</Button> : <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="فروشگاه"><select className={inputClass} disabled={busy} value={storeId} onChange={e => setStoreId(e.target.value)}><option value="">انتخاب فروشگاه</option>{stores.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></Field>
        <Field label="ویژگی حسابداری"><select className={inputClass} disabled={busy} value={definitionId} onChange={e => setDefinitionId(e.target.value)}><option value="">انتخاب ویژگی</option>{definitions.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></Field>
      </div>
      {definition && storeId ? <>
        <Field label="نامک ویژگی ووکامرس (بدون pa_)"><input dir="ltr" className={inputClass} disabled={busy} value={slug} onChange={e => { setSlug(e.target.value); setReviewed(false); }} placeholder="color" /></Field>
        {terms.map((term, index) => <div key={term.local} className="grid gap-3 sm:grid-cols-3">
          <p className="self-center">{term.local}</p>
          <Field label={`نام مقدار فروشگاه برای ${term.local}`}><input className={inputClass} disabled={busy} value={term.name} onChange={e => { setTerms(current => current.map((t, i) => i === index ? { ...t, name: e.target.value } : t)); setReviewed(false); }} /></Field>
          <Field label={`نامک مقدار فروشگاه برای ${term.local}`}><input className={inputClass} dir="ltr" disabled={busy} value={term.slug} onChange={e => { setTerms(current => current.map((t, i) => i === index ? { ...t, slug: e.target.value } : t)); setReviewed(false); }} /></Field>
        </div>)}
        <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={reviewed} onChange={e => setReviewed(e.target.checked)} /><span>فروشگاه، ویژگی و تطبیق همهٔ مقدارها را بررسی کردم؛ ساخت موارد ناموجود را تأیید می‌کنم.</span></label>
        <Button disabled={busy || !reviewed || !slug || terms.some(t => !t.slug || !t.name)} onClick={async () => {
          setBusy(true); setError(""); setNotice("");
          const result = await api<{ error?: string }>("/api/products/attributes/woo", { method: "POST", body: JSON.stringify({ connectionId: storeId, definitionId, definitionVersion: definition.version, name: definition.name, slug, terms, reviewed }) });
          setBusy(false);
          if (result.ok) { setNotice("نگاشت در صف بررسی فروشگاه است؛ پس از پاسخ موفق برای انتشار تنوع‌ها قابل استفاده می‌شود."); setReviewed(false); }
          else setError(result.data.error === "plugin_job_unsupported" ? "برای ساخت ویژگی و مقدار، افزونهٔ فروشگاه را به‌روزرسانی کنید." : "نگاشت ثبت نشد؛ تغییرات ویژگی، تکرار نامک یا کار در حال اجرا را بررسی کنید.");
        }}>ثبت نگاشت و ساخت موارد ناموجود</Button>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>تازه‌سازی وضعیت نگاشت</Button>
      </> : null}
    </div>}
  </SectionCard>;
}
