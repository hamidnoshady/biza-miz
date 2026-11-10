"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { CRM_SOURCES, CRM_SOURCE_LABELS, type CrmSource } from "@/lib/crm-sources";
import { TOUCH_CHANNELS, TOUCH_CHANNEL_LABELS, type TouchChannel } from "@/lib/marketing-touchpoints";

type Lead = { id: string; name: string; organization: string };
function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function MyMarketingTouchForm({ assignment, onClose, onBusyChange, onCreated }: { assignment: { id: string; title: string; target: string }; onClose: () => void; onBusyChange: (busy: boolean) => void; onCreated: () => void }) {
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [leads, setLeads] = useState<Lead[]>([]); const [searched, setSearched] = useState(false); const [selected, setSelected] = useState("");
  const [channel, setChannel] = useState<TouchChannel>("in_person"); const [source, setSource] = useState<CrmSource>("manual");
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const sequence = useRef(0); const pending = useRef<{ signature: string; key: string } | null>(null);
  async function find(term: string, requestedPage: number) {
    const seq = ++sequence.current; setError(""); setLeads([]); setSelected(""); setSearched(false); setNotice("");
    if (!term.trim()) { setError("برای جست‌وجوی سرنخ نام یا شماره را وارد کنید."); return; }
    const res = await api<{ leads: Lead[]; total: number }>(`/api/crm/leads?q=${encodeURIComponent(term.trim())}&limit=20&offset=${(requestedPage-1)*20}`);
    if (seq !== sequence.current) return;
    if (!res.ok) setError("جست‌وجوی سرنخ ممکن نشد؛ دسترسی یا وضعیت CRM را بررسی کنید.");
    else { setSearch(term.trim()); setPage(requestedPage); setTotal(res.data.total); setLeads(res.data.leads); setSearched(true); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!selected) { setError("سرنخ موجود را انتخاب کنید."); return; }
    const payload = { assignmentId: assignment.id, leadId: selected, channel, source }; const signature = JSON.stringify(payload);
    if (!pending.current || pending.current.signature !== signature) pending.current = { signature, key: newKey() };
    setBusy(true); onBusyChange(true); setError(""); setNotice("");
    const result = await api<{ error?: string }>("/api/growth/my-marketing-touchpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, idempotencyKey: pending.current.key }) });
    setBusy(false); onBusyChange(false);
    if (!result.ok) { setError(result.data?.error === "party_mismatch" ? "سرنخ به شخص دیگری تبدیل شده است؛ در CRM بررسی کنید." : "ثبت تأیید نشد؛ با همین اطلاعات دوباره تلاش کنید. دسترسی و وضعیت ماموریت را بررسی کنید."); return; }
    onCreated(); pending.current = null; setSelected(""); setLeads([]); setSearched(false); setQ(""); setNotice("تعامل گزارش شد.");
  }
  return <SectionCard title="گزارش تعامل من" description={`ماموریت: ${assignment.title} — ${assignment.target}. این گزارش مدرک ملاقات، رضایت، فروش یا پاداش نیست.`}>
    <p>کلید تلاش مجدد فقط تا زمانی که این فرم باز است در حافظه می‌ماند؛ پس از خطای نامشخص، پیش از بستن یا تغییر اطلاعات با همین انتخاب دوباره تلاش کنید.</p>
    {error ? <ErrorBox>{error}</ErrorBox> : null}{notice ? <p role="status">{notice}</p> : null}
    <Field label="جست‌وجوی سرنخ موجود در CRM"><input className={inputClass} maxLength={150} disabled={busy} value={q} onChange={(e) => { sequence.current++; setQ(e.target.value); setLeads([]); setSelected(""); setSearched(false); }} /></Field>
    <Button type="button" variant="outline" disabled={busy} onClick={() => void find(q,1)}>جست‌وجوی سرنخ</Button>
    {searched && !leads.length ? <p role="status">سرنخی یافت نشد.</p> : null}
    {leads.length ? <Field label="سرنخ موجود"><select className={inputClass} disabled={busy} value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">انتخاب سرنخ</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.name}{lead.organization ? ` — ${lead.organization}` : ""}</option>)}</select></Field> : null}
    {searched ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy || page===1} onClick={() => void find(search,page-1)}>صفحه قبل سرنخ‌ها</Button><Button type="button" variant="outline" disabled={busy || page*20>=total} onClick={() => void find(search,page+1)}>صفحه بعد سرنخ‌ها</Button></div> : null}
    <form onSubmit={submit}>
      <Field label="کانال"><select className={inputClass} disabled={busy} value={channel} onChange={(e) => setChannel(e.target.value as TouchChannel)}>{TOUCH_CHANNELS.map((item) => <option key={item} value={item}>{TOUCH_CHANNEL_LABELS[item]}</option>)}</select></Field>
      <Field label="منبع تعامل"><select className={inputClass} disabled={busy} value={source} onChange={(e) => setSource(e.target.value as CrmSource)}>{CRM_SOURCES.map((item) => <option key={item} value={item}>{CRM_SOURCE_LABELS[item]}</option>)}</select></Field>
      <Button type="submit" disabled={busy}>{busy ? "در حال ثبت…" : "ثبت گزارش"}</Button><Button type="button" variant="outline" disabled={busy} onClick={onClose}>بستن گزارش</Button>
    </form>
  </SectionCard>;
}
