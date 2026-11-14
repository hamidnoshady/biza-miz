"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { formatJalali } from "@/lib/jalali";
import { ASSIGNMENT_PRIORITIES, ASSIGNMENT_PRIORITY_LABELS, type AssignmentPriority, type AssignmentStatus } from "@/lib/marketing-operations";

const STATUS: Record<AssignmentStatus, string> = { planned: "برنامه‌ریزی‌شده", in_progress: "در حال انجام", completed: "تکمیل‌شده", canceled: "لغوشده" };
type Row = { id: string; title: string; target: string; agent: string; location_name: string; status: AssignmentStatus; priority: AssignmentPriority; priority_revision: number; due_date: string | null };
type List = { assignments: Row[]; hasMore: boolean };
type Options = { locations: { id: string; name: string }[]; targets: { id: string; location_id: string; site_label: string }[]; targetHasMore: boolean; agents: { id: string; location_id: string; name: string }[]; agentHasMore: boolean };
export function MarketingAssignmentsSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<List | null>(null); const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState(""); const [formError, setFormError] = useState(""); const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [priorityFilter, setPriorityFilter] = useState<AssignmentPriority | "">("");
  const [locationId, setLocationId] = useState(""); const [targetId, setTargetId] = useState(""); const [agentId, setAgentId] = useState("");
  const [targetQ, setTargetQ] = useState(""); const [targetSearch, setTargetSearch] = useState(""); const [targetPage, setTargetPage] = useState(1);
  const [agentQ, setAgentQ] = useState(""); const [agentSearch, setAgentSearch] = useState(""); const [agentPage, setAgentPage] = useState(1);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [title, setTitle] = useState(""); const [dueDate, setDueDate] = useState(""); const [priority, setPriority] = useState<AssignmentPriority>("normal");
  const [priorityEdit, setPriorityEdit] = useState<Row | null>(null); const [newPriority, setNewPriority] = useState<AssignmentPriority>("normal");
  const requestSequence = useRef(0); const optionsSequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSequence.current; setData(null); setError(""); setPriorityEdit(null);
    const res = await api<List>(`/api/growth/marketing-assignments?q=${encodeURIComponent(search)}&page=${page}${priorityFilter ? `&priority=${priorityFilter}` : ""}`);
    if (seq !== requestSequence.current) return;
    if (!res.ok) setError("دریافت ماموریت‌ها ممکن نشد."); else setData(res.data);
  }, [search, page, priorityFilter]);
  const loadOptions = useCallback(async () => {
    const seq = ++optionsSequence.current; setOptionsLoading(true);
    const res = await api<Options>(`/api/growth/marketing-assignments/options?location=${encodeURIComponent(locationId)}&targetQ=${encodeURIComponent(targetSearch)}&targetPage=${targetPage}&agentQ=${encodeURIComponent(agentSearch)}&agentPage=${agentPage}`);
    if (seq !== optionsSequence.current) return;
    setOptionsLoading(false);
    if (!res.ok) { setOptions(null); setFormError("دریافت گزینه‌های ماموریت ممکن نشد."); } else {
      setOptions(res.data); setFormError("");
      setTargetId((id) => res.data.targets.some((item) => item.id === id && item.location_id === locationId) ? id : "");
      setAgentId((id) => res.data.agents.some((item) => item.id === id && item.location_id === locationId) ? id : "");
    }
  }, [locationId, targetSearch, targetPage, agentSearch, agentPage]);
  useEffect(() => { const seq = requestSequence; void load(); return () => { seq.current++; }; }, [load]);
  useEffect(() => { const seq = optionsSequence; if (canManage) void loadOptions(); return () => { seq.current++; }; }, [canManage, loadOptions]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFormError("");
    const res = await api<{ error?: string }>("/api/growth/marketing-assignments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locationId, targetId, agentId, title, dueDate, priority }) });
    setBusy(false);
    if (!res.ok) { setFormError(res.data?.error === "assignment_already_open" ? "برای این بازاریاب و مقصد ماموریت باز وجود دارد." : "ثبت ماموریت ممکن نشد؛ شعبه، مقصد و بازاریاب را بررسی کنید."); return; }
    setTitle(""); setDueDate(""); setPriority("normal"); await load();
  }
  async function transition(row: Row, next: AssignmentStatus) {
    setBusy(true); setError("");
    const res = await api(`/api/growth/marketing-assignments/${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected: row.status, next }) });
    setBusy(false);
    if (!res.ok) { setError("تغییر وضعیت ممکن نشد؛ ممکن است ماموریت هم‌زمان تغییر کرده باشد. فهرست را دوباره دریافت کنید."); return; }
    await load();
  }
  async function savePriority(e: React.FormEvent) {
    e.preventDefault();
    if (!priorityEdit || newPriority === priorityEdit.priority) return;
    setBusy(true); setError("");
    const res = await api(`/api/growth/marketing-assignments/${encodeURIComponent(priorityEdit.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "priority", expectedRevision: priorityEdit.priority_revision, priority: newPriority }) });
    setBusy(false);
    if (!res.ok) { setError("تغییر اولویت ممکن نشد؛ وضعیت، دسترسی یا اولویت ماموریت ممکن است تغییر کرده باشد. فهرست را دوباره دریافت کنید."); return; }
    await load();
  }
  return <div className="space-y-4">
    <SectionCard title="ماموریت‌های بازاریابی" description="تکمیل یک وظیفه به‌تنهایی مدرک ملاقات یا تحقق فروش نیست.">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
        <label htmlFor="assignment-search" className="sr-only">جست‌وجوی ماموریت</label><input id="assignment-search" className={inputClass} disabled={busy} maxLength={150} value={q} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجوی عنوان" /><Button type="submit" variant="outline" disabled={busy}>جست‌وجو</Button>
      </form>
      <label htmlFor="assignment-priority-filter">فیلتر اولویت</label><select id="assignment-priority-filter" className={inputClass} disabled={busy} value={priorityFilter} onChange={(e) => { setPage(1); setPriorityFilter(e.target.value as AssignmentPriority | ""); }}><option value="">همه اولویت‌ها</option>{ASSIGNMENT_PRIORITIES.map((p) => <option key={p} value={p}>{ASSIGNMENT_PRIORITY_LABELS[p]}</option>)}</select>
      {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
      {!data && !error ? <SectionCardSkeleton /> : null}
      {data?.assignments.length === 0 ? <EmptyState>ماموریتی یافت نشد.</EmptyState> : null}
      {data && data.assignments.length > 0 ? <DataTable caption="ماموریت‌های بازاریابی"><DataTableHead><Th>عنوان</Th><Th>مقصد</Th><Th>بازاریاب</Th><Th>شعبه</Th><Th>مهلت</Th><Th>اولویت</Th><Th>وضعیت</Th>{canManage ? <Th>عملیات</Th> : null}</DataTableHead>
        <DataTableBody>{data.assignments.map((r) => <DataTableRow key={r.id}><Td>{r.title}</Td><Td>{r.target}</Td><Td>{r.agent}</Td><Td>{r.location_name}</Td><Td>{r.due_date ? formatJalali(r.due_date, { timeZone: "UTC" }) : "—"}</Td><Td>{ASSIGNMENT_PRIORITY_LABELS[r.priority]}</Td><Td>{STATUS[r.status]}</Td>{canManage ? <Td>{r.status === "planned" || r.status === "in_progress" ? <Button type="button" variant="outline" disabled={busy} onClick={() => { setPriorityEdit(r); setNewPriority(r.priority); }}>تغییر اولویت</Button> : null}{r.status === "planned" ? <Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"in_progress")}>شروع</Button> : null}{r.status === "planned" || r.status === "in_progress" ? <><Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"completed")}>تکمیل</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"canceled")}>لغو</Button></> : null}</Td> : null}</DataTableRow>)}</DataTableBody></DataTable> : null}
      {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy || page === 1} onClick={() => setPage(page - 1)}>صفحه قبل</Button><Button type="button" variant="outline" disabled={busy || !data.hasMore} onClick={() => setPage(page + 1)}>صفحه بعد</Button></div> : null}
      {canManage && priorityEdit ? <form onSubmit={savePriority}>
        <p>تغییر اولویت ماموریت: {priorityEdit.title}</p>
        <Field label="اولویت جدید"><select className={inputClass} disabled={busy} value={newPriority} onChange={(e) => setNewPriority(e.target.value as AssignmentPriority)}>{ASSIGNMENT_PRIORITIES.map((p) => <option key={p} value={p}>{ASSIGNMENT_PRIORITY_LABELS[p]}</option>)}</select></Field>
        <Button type="submit" disabled={busy || newPriority === priorityEdit.priority}>ذخیره اولویت</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setPriorityEdit(null)}>انصراف</Button>
      </form> : null}
    </SectionCard>
    {canManage ? <SectionCard title="ثبت ماموریت" description="بازاریاب و مقصد باید به همان شعبه تعلق داشته باشند. برای یافتن موارد بیشتر جست‌وجو کنید یا صفحه را تغییر دهید.">
      {formError ? <><ErrorBox>{formError}</ErrorBox>{options ? <Button type="button" variant="outline" onClick={() => void loadOptions()}>دریافت دوباره گزینه‌ها</Button> : null}</> : null}
      {optionsLoading ? <p role="status">در حال دریافت گزینه‌ها…</p> : null}
      {!options ? <Button type="button" variant="outline" disabled={optionsLoading} onClick={() => void loadOptions()}>دریافت گزینه‌ها</Button> : <form onSubmit={submit}>
        <Field label="شعبه"><select className={inputClass} required value={locationId} onChange={(e) => { setLocationId(e.target.value); setTargetId(""); setAgentId(""); setTargetQ(""); setTargetSearch(""); setTargetPage(1); setAgentQ(""); setAgentSearch(""); setAgentPage(1); }}><option value="">انتخاب شعبه</option>{options.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="جست‌وجوی مقصد"><input className={inputClass} maxLength={150} value={targetQ} onChange={(e) => setTargetQ(e.target.value)} /></Field><Button type="button" variant="outline" disabled={!locationId || optionsLoading} onClick={() => { setTargetId(""); setTargetPage(1); setTargetSearch(targetQ.trim()); }}>جست‌وجوی مقصد</Button>
        <Field label="مقصد"><select className={inputClass} required disabled={!locationId || optionsLoading} value={targetId} onChange={(e) => setTargetId(e.target.value)}><option value="">انتخاب مقصد</option>{options.targets.filter((t) => t.location_id === locationId).map((t) => <option key={t.id} value={t.id}>{t.site_label}</option>)}</select></Field>
        <Button type="button" variant="outline" disabled={optionsLoading || targetPage === 1} onClick={() => { setTargetId(""); setTargetPage(targetPage-1); }}>مقصدهای قبل</Button><Button type="button" variant="outline" disabled={optionsLoading || !options.targetHasMore} onClick={() => { setTargetId(""); setTargetPage(targetPage+1); }}>مقصدهای بعد</Button>
        <Field label="جست‌وجوی بازاریاب"><input className={inputClass} maxLength={150} value={agentQ} onChange={(e) => setAgentQ(e.target.value)} /></Field><Button type="button" variant="outline" disabled={!locationId || optionsLoading} onClick={() => { setAgentId(""); setAgentPage(1); setAgentSearch(agentQ.trim()); }}>جست‌وجوی بازاریاب</Button>
        <Field label="بازاریاب"><select className={inputClass} required disabled={!locationId || optionsLoading} value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">انتخاب بازاریاب</option>{options.agents.filter((a) => a.location_id === locationId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Button type="button" variant="outline" disabled={optionsLoading || agentPage === 1} onClick={() => { setAgentId(""); setAgentPage(agentPage-1); }}>بازاریابان قبل</Button><Button type="button" variant="outline" disabled={optionsLoading || !options.agentHasMore} onClick={() => { setAgentId(""); setAgentPage(agentPage+1); }}>بازاریابان بعد</Button>
        <Field label="عنوان وظیفه"><input className={inputClass} required maxLength={150} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="اولویت"><select className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value as AssignmentPriority)}>{ASSIGNMENT_PRIORITIES.map((p) => <option key={p} value={p}>{ASSIGNMENT_PRIORITY_LABELS[p]}</option>)}</select></Field>
        <Field label="مهلت (اختیاری)" as="div"><JalaliDatePicker ariaLabel="مهلت ماموریت" value={dueDate} onChange={setDueDate} /></Field>
        <Button type="submit" disabled={busy || optionsLoading}>{busy ? "در حال ثبت…" : "ثبت ماموریت"}</Button>
      </form>}
    </SectionCard> : null}
  </div>;
}
