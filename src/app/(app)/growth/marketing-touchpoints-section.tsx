"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { CRM_SOURCES, CRM_SOURCE_LABELS, type CrmSource } from "@/lib/crm-sources";
import { TOUCH_CHANNELS, TOUCH_CHANNEL_LABELS, type TouchChannel } from "@/lib/marketing-touchpoints";

type Touch = { id: string; title: string; target: string; agent: string; location_name: string; location_timezone: string; channel: TouchChannel; source: CrmSource; recorded_at: string; lead_id: string | null; lead_name: string | null };
type TouchList = { touches: Touch[]; hasMore: boolean };
type Assignment = { id: string; title: string; target: string; location_name: string };
type Lead = { id: string; name: string; organization: string };
type OptionList = { assignments: Assignment[]; hasMore: boolean };

/** getRandomValues is also available on local installations without randomUUID. */
function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function MarketingTouchpointsSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<TouchList | null>(null); const [error, setError] = useState("");
  const [query, setQuery] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [assignSearch, setAssignSearch] = useState(""); const [assignQuery, setAssignQuery] = useState(""); const [assignPage, setAssignPage] = useState(1);
  const [options, setOptions] = useState<OptionList | null>(null); const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [leadQuery, setLeadQuery] = useState(""); const [leadSearch, setLeadSearch] = useState(""); const [leadPage, setLeadPage] = useState(1); const [leadTotal, setLeadTotal] = useState(0); const [leads, setLeads] = useState<Lead[]>([]); const [searched, setSearched] = useState(false); const [lead, setLead] = useState<Lead | null>(null);
  const [channel, setChannel] = useState<TouchChannel>("in_person"); const [source, setSource] = useState<CrmSource>("manual");
  const [formError, setFormError] = useState(""); const [busy, setBusy] = useState(false);
  const listSequence = useRef(0); const optionSequence = useRef(0); const leadSequence = useRef(0);
  const pendingKey = useRef<{ signature: string; key: string } | null>(null);
  const load = useCallback(async () => {
    const seq = ++listSequence.current; setError(""); setData(null);
    const res = await api<TouchList>(`/api/growth/marketing-touchpoints?q=${encodeURIComponent(search)}&page=${page}`);
    if (seq !== listSequence.current) return;
    if (!res.ok) setError("دریافت تعاملات ممکن نشد."); else setData(res.data);
  }, [search, page]);
  const loadOptions = useCallback(async () => {
    const seq = ++optionSequence.current;
    const res = await api<OptionList>(`/api/growth/marketing-touchpoints/options?q=${encodeURIComponent(assignSearch)}&page=${assignPage}`);
    if (seq !== optionSequence.current) return;
    if (!res.ok) setFormError("دریافت ماموریت‌ها ممکن نشد."); else setOptions(res.data);
  }, [assignSearch, assignPage]);
  useEffect(() => { const seq = listSequence; void load(); return () => { seq.current++; }; }, [load]);
  useEffect(() => { const seq = optionSequence; if (canManage) void loadOptions(); return () => { seq.current++; }; }, [canManage, loadOptions]);
  async function findLeads(term: string, requestedPage: number) {
    const seq = ++leadSequence.current; setFormError(""); setLeads([]); setLead(null); setSearched(false);
    if (!term.trim()) { setFormError("برای جست‌وجوی سرنخ، نام یا شماره را وارد کنید."); return; }
    const res = await api<{ leads: Lead[]; total: number }>(`/api/crm/leads?q=${encodeURIComponent(term.trim())}&limit=20&offset=${(requestedPage - 1) * 20}`);
    if (seq !== leadSequence.current) return;
    if (!res.ok) setFormError("جست‌وجوی سرنخ ممکن نشد."); else { setLeadSearch(term.trim()); setLeadPage(requestedPage); setLeadTotal(res.data.total); setLeads(res.data.leads); setSearched(true); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!assignment || !lead) { setFormError("ماموریت و سرنخ را انتخاب کنید."); return; }
    const payload = { assignmentId: assignment.id, leadId: lead.id, channel, source };
    const signature = JSON.stringify(payload);
    if (!pendingKey.current || pendingKey.current.signature !== signature) pendingKey.current = { signature, key: newIdempotencyKey() };
    setBusy(true); setFormError("");
    const res = await api<{ error?: string }>("/api/growth/marketing-touchpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: pendingKey.current.key }) });
    setBusy(false);
    if (!res.ok) {
      setFormError(res.data?.error === "party_mismatch" ? "سرنخ تبدیل‌شده به شخص دیگری متصل است؛ ابتدا در CRM بررسی کنید." : "ثبت تعامل تایید نشد؛ با همین اطلاعات دوباره تلاش کنید تا از ثبت تکراری جلوگیری شود.");
      return;
    }
    pendingKey.current = null; setLead(null); setLeads([]); setLeadQuery(""); setSearched(false); await load();
  }
  return <div className="space-y-4">
    <SectionCard title="تعاملات بازاریابی" description="ثبت دستی تعامل با سرنخ موجود؛ این فهرست نه مدرک ملاقات است و نه فروش، رضایت یا درآمد منتسب.">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query.trim()); }}>
        <label htmlFor="touch-search" className="sr-only">جست‌وجوی عنوان ماموریت</label><input id="touch-search" className={inputClass} maxLength={150} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جست‌وجوی عنوان ماموریت" /><Button type="submit" variant="outline">جست‌وجو</Button>
      </form>
      {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
      {!data && !error ? <SectionCardSkeleton /> : null}
      {data?.touches.length === 0 ? <EmptyState>تعاملی ثبت نشده است.</EmptyState> : null}
      {data && data.touches.length > 0 ? <DataTable caption="تعاملات بازاریابی"><DataTableHead><Th>ماموریت</Th><Th>مقصد</Th><Th>بازاریاب</Th><Th>شعبه</Th><Th>سرنخ</Th><Th>کانال</Th><Th>منبع تعامل</Th><Th>زمان ثبت</Th></DataTableHead>
        <DataTableBody>{data.touches.map((r) => <DataTableRow key={r.id}><Td>{r.title}</Td><Td>{r.target}</Td><Td>{r.agent}</Td><Td>{r.location_name}</Td><Td>{r.lead_name ?? "محدود"}</Td><Td>{TOUCH_CHANNEL_LABELS[r.channel]}</Td><Td>{CRM_SOURCE_LABELS[r.source]}</Td><Td>{formatJalali(r.recorded_at, { withTime: true, timeZone: r.location_timezone })}</Td></DataTableRow>)}</DataTableBody></DataTable> : null}
      {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>صفحه قبل</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>صفحه بعد</Button></div> : null}
    </SectionCard>
    {canManage ? <SectionCard title="ثبت تعامل" description="تنها سرنخ موجود در CRM را انتخاب کنید. ثبت تعامل منبع اولیه، رضایت یا وضعیت سرنخ را تغییر نمی‌دهد.">
      {formError ? <ErrorBox>{formError}</ErrorBox> : null}
      <Field label="جست‌وجوی ماموریت"><input className={inputClass} maxLength={150} value={assignQuery} onChange={(e) => setAssignQuery(e.target.value)} /></Field>
      <Button type="button" variant="outline" onClick={() => { setAssignment(null); setAssignPage(1); setAssignSearch(assignQuery.trim()); if (assignSearch === assignQuery.trim() && assignPage === 1) void loadOptions(); }}>جست‌وجوی ماموریت</Button>
      {!options ? <Button type="button" variant="outline" onClick={() => void loadOptions()}>دریافت ماموریت‌ها</Button> : <>
        <Field label="ماموریت"><select className={inputClass} value={assignment?.id ?? ""} onChange={(e) => setAssignment(options.assignments.find((a) => a.id === e.target.value) ?? null)}><option value="">انتخاب ماموریت</option>{options.assignments.map((a) => <option key={a.id} value={a.id}>{a.title} — {a.target} — {a.location_name}</option>)}</select></Field>
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={assignPage === 1} onClick={() => { setAssignment(null); setAssignPage(assignPage - 1); }}>صفحه قبل ماموریت‌ها</Button><Button type="button" variant="outline" disabled={!options.hasMore} onClick={() => { setAssignment(null); setAssignPage(assignPage + 1); }}>صفحه بعد ماموریت‌ها</Button></div>
      </>}
      <Field label="جست‌وجوی سرنخ در CRM"><input className={inputClass} maxLength={150} value={leadQuery} onChange={(e) => { leadSequence.current++; setLeadQuery(e.target.value); setLeads([]); setLead(null); setSearched(false); }} /></Field>
      <Button type="button" variant="outline" onClick={() => void findLeads(leadQuery, 1)}>جست‌وجوی سرنخ</Button>
      {searched && leads.length === 0 ? <p role="status">سرنخی یافت نشد.</p> : null}
      {leads.length ? <Field label="سرنخ"><select className={inputClass} value={lead?.id ?? ""} onChange={(e) => setLead(leads.find((l) => l.id === e.target.value) ?? null)}><option value="">انتخاب سرنخ</option>{leads.map((l) => <option key={l.id} value={l.id}>{l.name}{l.organization ? ` — ${l.organization}` : ""}</option>)}</select></Field> : null}
      {searched ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={leadPage === 1} onClick={() => void findLeads(leadSearch, leadPage - 1)}>صفحه قبل سرنخ‌ها</Button><Button type="button" variant="outline" disabled={leadPage * 20 >= leadTotal} onClick={() => void findLeads(leadSearch, leadPage + 1)}>صفحه بعد سرنخ‌ها</Button></div> : null}
      <form onSubmit={submit}>
        <Field label="کانال"><select className={inputClass} value={channel} onChange={(e) => setChannel(e.target.value as TouchChannel)}>{TOUCH_CHANNELS.map((c) => <option key={c} value={c}>{TOUCH_CHANNEL_LABELS[c]}</option>)}</select></Field>
        <Field label="منبع تعامل"><select className={inputClass} value={source} onChange={(e) => setSource(e.target.value as CrmSource)}>{CRM_SOURCES.map((s) => <option key={s} value={s}>{CRM_SOURCE_LABELS[s]}</option>)}</select></Field>
        <Button type="submit" disabled={busy}>{busy ? "در حال ثبت…" : "ثبت تعامل"}</Button>
      </form>
    </SectionCard> : null}
  </div>;
}
