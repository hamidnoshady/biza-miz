"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";

type Row = { id: string; site_label: string; city: string; neighborhood: string; location_name: string; party_linked: boolean };
type TargetList = { targets: Row[]; hasMore: boolean };
type Locations = { locations: { id: string; name: string }[] };
type Party = { id: string; displayName: string };

export function MarketingTargetsSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<TargetList | null>(null);
  const [locations, setLocations] = useState<Locations | null>(null);
  const [error, setError] = useState(""); const [formError, setFormError] = useState("");
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [locationId, setLocationId] = useState(""); const [siteLabel, setSiteLabel] = useState("");
  const [city, setCity] = useState(""); const [neighborhood, setNeighborhood] = useState("");
  const [partyQuery, setPartyQuery] = useState(""); const [parties, setParties] = useState<Party[]>([]); const [partySearched, setPartySearched] = useState(false);
  const [selected, setSelected] = useState<Party | null>(null); const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0); const partySequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSequence.current; setData(null); setError("");
    const res = await api<TargetList>(`/api/growth/marketing-targets?q=${encodeURIComponent(search)}&page=${page}`);
    if (seq !== requestSequence.current) return;
    if (!res.ok) setError("دریافت مقصدها ممکن نشد."); else setData(res.data);
  }, [search, page]);
  const loadLocations = useCallback(async () => {
    const res = await api<Locations>("/api/growth/marketing-targets/locations");
    if (!res.ok) setFormError("دریافت شعبه‌ها ممکن نشد."); else setLocations(res.data);
  }, []);
  useEffect(() => { const seq = requestSequence; void load(); return () => { seq.current++; }; }, [load]);
  useEffect(() => { if (canManage) void loadLocations(); }, [canManage, loadLocations]);
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
  return <div className="space-y-4">
    <SectionCard title="مقصدهای بازاریابی" description="محل هدف بیرونی از شعبه داخلی کسب‌وکار جداست. اتصال به شخص موجود رضایت بازاریابی ایجاد نمی‌کند.">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
        <label htmlFor="target-search" className="sr-only">جست‌وجوی مقصد یا شهر</label><input id="target-search" className={inputClass} value={q} maxLength={150} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجوی مقصد یا شهر" /><Button type="submit" variant="outline">جست‌وجو</Button>
      </form>
      {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
      {!data && !error ? <SectionCardSkeleton /> : null}
      {data?.targets.length === 0 ? <EmptyState>مقصدی یافت نشد.</EmptyState> : null}
      {data && data.targets.length > 0 ? <DataTable caption="مقصدهای بازاریابی"><DataTableHead><Th>محل</Th><Th>شهر</Th><Th>محله</Th><Th>شعبه مسئول</Th><Th>شخص مرتبط</Th></DataTableHead><DataTableBody>{data.targets.map((r) => <DataTableRow key={r.id}><Td>{r.site_label}</Td><Td>{r.city || "—"}</Td><Td>{r.neighborhood || "—"}</Td><Td>{r.location_name}</Td><Td>{r.party_linked ? "متصل" : "بدون اتصال"}</Td></DataTableRow>)}</DataTableBody></DataTable> : null}
      {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>صفحه قبل</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>صفحه بعد</Button></div> : null}
    </SectionCard>
    {canManage ? <SectionCard title="افزودن مقصد" description="برای هر محل یک عنوان عملیاتی وارد کنید؛ شخص مرتبط اختیاری است و در دفتر اشخاص مدیریت می‌شود.">
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
