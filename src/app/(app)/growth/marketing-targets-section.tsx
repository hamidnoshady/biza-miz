"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";

type Row = { id: string; site_label: string; city: string; neighborhood: string; location_name: string; party_linked: boolean; status: "active" | "archived"; revision: number };
type TargetList = { targets: Row[]; hasMore: boolean };
type Locations = { locations: { id: string; name: string }[] };
type Party = { id: string; displayName: string };

export function MarketingTargetsSection({ canManage, canCreate }: { canManage: boolean; canCreate: boolean }) {
  const [data, setData] = useState<TargetList | null>(null);
  const [locations, setLocations] = useState<Locations | null>(null);
  const [error, setError] = useState(""); const [formError, setFormError] = useState("");
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [editing, setEditing] = useState<Row | null>(null);
  const [editLabel, setEditLabel] = useState(""); const [editCity, setEditCity] = useState(""); const [editNeighborhood, setEditNeighborhood] = useState("");
  const [pending, setPending] = useState<Row | null>(null);
  const [locationId, setLocationId] = useState(""); const [siteLabel, setSiteLabel] = useState("");
  const [city, setCity] = useState(""); const [neighborhood, setNeighborhood] = useState("");
  const [partyQuery, setPartyQuery] = useState(""); const [parties, setParties] = useState<Party[]>([]); const [partySearched, setPartySearched] = useState(false);
  const [selected, setSelected] = useState<Party | null>(null); const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0); const partySequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSequence.current; setData(null); setError("");
    const res = await api<TargetList>(`/api/growth/marketing-targets?q=${encodeURIComponent(search)}&page=${page}&status=${status}`);
    if (seq !== requestSequence.current) return;
    if (!res.ok) setError("دریافت مقصدها ممکن نشد."); else setData(res.data);
  }, [search, page, status]);
  const loadLocations = useCallback(async () => {
    const res = await api<Locations>("/api/growth/marketing-targets/locations");
    if (!res.ok) setFormError("دریافت شعبه‌ها ممکن نشد."); else setLocations(res.data);
  }, []);
  useEffect(() => { const seq = requestSequence; void load(); return () => { seq.current++; }; }, [load]);
  useEffect(() => { if (canCreate) void loadLocations(); }, [canCreate, loadLocations]);
  async function searchParties() {
    const seq = ++partySequence.current; setFormError(""); setParties([]); setPartySearched(false);
    if (!partyQuery.trim()) { setFormError("برای جست‌وجوی شخص، نام را وارد کنید."); return; }
    const result = await api<{ parties: Party[] }>(`/api/parties?q=${encodeURIComponent(partyQuery.trim())}&limit=20`);
    if (seq !== partySequence.current) return;
    if (!result.ok) setFormError("جست‌وجوی اشخاص ممکن نشد."); else { setParties(result.data.parties); setPartySearched(true); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFormError("");
    const res = await api("/api/growth/marketing-targets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locationId, siteLabel, city, neighborhood, partyId: selected?.id ?? null }) });
    setBusy(false);
    if (!res.ok) { setFormError("ثبت مقصد ممکن نشد؛ شعبه و شخص انتخاب‌شده را بررسی کنید."); return; }
    setSiteLabel(""); setCity(""); setNeighborhood(""); setSelected(null); setParties([]); setPartySearched(false); setPartyQuery(""); await load();
  }
  async function change(row: Row, payload: object) {
    setBusy(true); setError("");
    const res = await api<{ error?: string }>(`/api/growth/marketing-targets/${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, expectedRevision: row.revision }) });
    setBusy(false);
    if (!res.ok) {
      setError(res.data?.error === "open_assignments" ? "این مقصد ماموریت باز دارد؛ ابتدا ماموریت‌ها را تکمیل یا لغو کنید." : "تغییر ممکن نشد؛ دسترسی یا نسخهٔ مقصد ممکن است تغییر کرده باشد. فهرست را دوباره دریافت کنید.");
      return;
    }
    setEditing(null); setPending(null); await load();
  }
  return <div className="space-y-4">
    <SectionCard title="مقصدهای بازاریابی" description="محل هدف بیرونی از شعبه داخلی کسب‌وکار جداست. اتصال به شخص موجود رضایت بازاریابی ایجاد نمی‌کند.">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
        <label htmlFor="target-search" className="sr-only">جست‌وجوی مقصد یا شهر</label><input id="target-search" className={inputClass} value={q} maxLength={150} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجوی مقصد یا شهر" /><Button type="submit" variant="outline">جست‌وجو</Button>
      </form>
      <Field label="وضعیت مقصد"><select className={inputClass} value={status} onChange={(e) => { setStatus(e.target.value as "active" | "archived"); setPage(1); setEditing(null); setPending(null); }}><option value="active">فعال</option><option value="archived">بایگانی‌شده</option></select></Field>
      {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
      {!data && !error ? <SectionCardSkeleton /> : null}
      {data?.targets.length === 0 ? <EmptyState>مقصدی یافت نشد.</EmptyState> : null}
      {data && data.targets.length > 0 ? <DataTable caption="مقصدهای بازاریابی"><DataTableHead><Th>محل</Th><Th>شهر</Th><Th>محله</Th><Th>شعبه مسئول</Th><Th>شخص مرتبط</Th>{canManage ? <Th>عملیات</Th> : null}</DataTableHead><DataTableBody>{data.targets.map((r) => <DataTableRow key={r.id}><Td>{r.site_label}</Td><Td>{r.city || "—"}</Td><Td>{r.neighborhood || "—"}</Td><Td>{r.location_name}</Td><Td>{r.party_linked ? "متصل" : "بدون اتصال"}</Td>{canManage ? <Td>{r.status === "active" ? <Button type="button" variant="outline" disabled={busy} onClick={() => { setPending(null); setEditing(r); setEditLabel(r.site_label); setEditCity(r.city); setEditNeighborhood(r.neighborhood); }}>ویرایش</Button> : null}<Button type="button" variant="outline" disabled={busy} onClick={() => { setEditing(null); setPending(r); }}>{r.status === "active" ? "بایگانی" : "بازگرداندن"}</Button></Td> : null}</DataTableRow>)}</DataTableBody></DataTable> : null}
      {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>صفحه قبل</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>صفحه بعد</Button></div> : null}
    </SectionCard>
    {canManage && editing ? <SectionCard title="ویرایش مقصد" description="شعبه و شخص مرتبط در این ویرایش تغییر نمی‌کنند.">
      <form onSubmit={(e) => { e.preventDefault(); void change(editing, { action: "edit", siteLabel: editLabel, city: editCity, neighborhood: editNeighborhood }); }}>
        <Field label="عنوان محل برای ویرایش"><input className={inputClass} required maxLength={150} value={editLabel} onChange={(e) => setEditLabel(e.target.value)} /></Field>
        <Field label="شهر برای ویرایش"><input className={inputClass} maxLength={100} value={editCity} onChange={(e) => setEditCity(e.target.value)} /></Field>
        <Field label="محله برای ویرایش"><input className={inputClass} maxLength={100} value={editNeighborhood} onChange={(e) => setEditNeighborhood(e.target.value)} /></Field>
        <Button type="submit" disabled={busy}>ذخیره تغییرات</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>انصراف از ویرایش</Button>
      </form>
    </SectionCard> : null}
    {canManage && pending ? <SectionCard title={pending.status === "active" ? "تأیید بایگانی مقصد" : "تأیید بازگرداندن مقصد"} description={pending.status === "active" ? "مقصدهای دارای ماموریت باز بایگانی نمی‌شوند. سابقه حذف نمی‌شود." : "مقصد دوباره برای ماموریت‌های جدید قابل انتخاب می‌شود."}>
      <p>{pending.site_label}</p><Button type="button" disabled={busy} onClick={() => void change(pending, { action: pending.status === "active" ? "archive" : "restore" })}>تأیید</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setPending(null)}>انصراف</Button>
    </SectionCard> : null}
    {canCreate ? <SectionCard title="افزودن مقصد" description="برای هر محل یک عنوان عملیاتی وارد کنید؛ شخص مرتبط اختیاری است و در دفتر اشخاص مدیریت می‌شود.">
      {formError ? <ErrorBox>{formError}</ErrorBox> : null}
      {!locations ? <Button type="button" variant="outline" onClick={() => void loadLocations()}>دریافت شعبه‌ها</Button> : <form onSubmit={submit}>
        <Field label="شعبه مسئول"><select className={inputClass} required value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">انتخاب شعبه</option>{locations.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="عنوان محل"><input className={inputClass} required maxLength={150} value={siteLabel} onChange={(e) => setSiteLabel(e.target.value)} /></Field>
        <Field label="شهر"><input className={inputClass} maxLength={100} value={city} onChange={(e) => setCity(e.target.value)} /></Field>
        <Field label="محله"><input className={inputClass} maxLength={100} value={neighborhood} onChange={(e) => setNeighborhood(e.target.value)} /></Field>
        <Field label="جست‌وجوی شخص موجود (اختیاری)"><input className={inputClass} maxLength={150} value={partyQuery} onChange={(e) => { partySequence.current++; setPartyQuery(e.target.value); setParties([]); setPartySearched(false); setSelected(null); }} /></Field>
        <Button type="button" variant="outline" onClick={() => void searchParties()}>جست‌وجوی شخص</Button>
        {partySearched && parties.length === 0 ? <p role="status">شخصی یافت نشد.</p> : null}
        {parties.length > 0 ? <Field label="انتخاب شخص"><select className={inputClass} value={selected?.id ?? ""} onChange={(e) => setSelected(parties.find((p) => p.id === e.target.value) ?? null)}><option value="">بدون شخص مرتبط</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></Field> : null}
        {selected ? <p>شخص انتخاب‌شده: {selected.displayName}</p> : null}
        <Button type="submit" disabled={busy}>{busy ? "در حال ثبت…" : "ثبت مقصد"}</Button>
      </form>}
    </SectionCard> : null}
  </div>;
}
