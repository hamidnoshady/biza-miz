"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { formatJalali } from "@/lib/jalali";
import type { AssignmentStatus } from "@/lib/marketing-operations";

const STATUS: Record<AssignmentStatus, string> = { planned: "برنامه‌ریزی‌شده", in_progress: "در حال انجام", completed: "تکمیل‌شده", canceled: "لغوشده" };
type Row = { id: string; title: string; target: string; agent: string; location_name: string; status: AssignmentStatus; due_date: string | null };
type List = { assignments: Row[]; hasMore: boolean };
type Options = { locations: { id: string; name: string }[]; targets: { id: string; location_id: string; site_label: string }[]; agents: { id: string; location_id: string; name: string }[] };
export function MarketingAssignmentsSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<List | null>(null); const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState(""); const [formError, setFormError] = useState(""); const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [locationId, setLocationId] = useState(""); const [targetId, setTargetId] = useState(""); const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState(""); const [dueDate, setDueDate] = useState("");
  const requestSequence = useRef(0); const optionsSequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSequence.current; setData(null); setError("");
    const res = await api<List>(`/api/growth/marketing-assignments?q=${encodeURIComponent(search)}&page=${page}`);
    if (seq !== requestSequence.current) return;
    if (!res.ok) setError("دریافت ماموریت‌ها ممکن نشد."); else setData(res.data);
  }, [search, page]);
  const loadOptions = useCallback(async () => {
    const seq = ++optionsSequence.current;
    const res = await api<Options>(`/api/growth/marketing-assignments/options?location=${encodeURIComponent(locationId)}`);
    if (seq !== optionsSequence.current) return;
    if (!res.ok) setFormError("دریافت گزینه‌های ماموریت ممکن نشد."); else setOptions(res.data);
  }, [locationId]);
  useEffect(() => { const seq = requestSequence; void load(); return () => { seq.current++; }; }, [load]);
  useEffect(() => { const seq = optionsSequence; if (canManage) void loadOptions(); return () => { seq.current++; }; }, [canManage, loadOptions]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setFormError("");
    const res = await api<{ error?: string }>("/api/growth/marketing-assignments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locationId, targetId, agentId, title, dueDate }) });
    setBusy(false);
    if (!res.ok) { setFormError(res.data?.error === "assignment_already_open" ? "برای این بازاریاب و مقصد ماموریت باز وجود دارد." : "ثبت ماموریت ممکن نشد؛ شعبه، مقصد و بازاریاب را بررسی کنید."); return; }
    setTitle(""); setDueDate(""); await load();
  }
  async function transition(row: Row, next: AssignmentStatus) {
    setBusy(true); setError("");
    const res = await api(`/api/growth/marketing-assignments/${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected: row.status, next }) });
    setBusy(false);
    if (!res.ok) { setError("تغییر وضعیت ممکن نشد؛ ممکن است ماموریت هم‌زمان تغییر کرده باشد. فهرست را دوباره دریافت کنید."); return; }
    await load();
  }
  return <div className="space-y-4">
    <SectionCard title="ماموریت‌های بازاریابی" description="تکمیل یک وظیفه به‌تنهایی مدرک ملاقات یا تحقق فروش نیست.">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
        <label htmlFor="assignment-search" className="sr-only">جست‌وجوی ماموریت</label><input id="assignment-search" className={inputClass} maxLength={150} value={q} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجوی عنوان" /><Button type="submit" variant="outline">جست‌وجو</Button>
      </form>
      {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
      {!data && !error ? <SectionCardSkeleton /> : null}
      {data?.assignments.length === 0 ? <EmptyState>ماموریتی یافت نشد.</EmptyState> : null}
      {data && data.assignments.length > 0 ? <DataTable caption="ماموریت‌های بازاریابی"><DataTableHead><Th>عنوان</Th><Th>مقصد</Th><Th>بازاریاب</Th><Th>شعبه</Th><Th>مهلت</Th><Th>وضعیت</Th>{canManage ? <Th>عملیات</Th> : null}</DataTableHead>
        <DataTableBody>{data.assignments.map((r) => <DataTableRow key={r.id}><Td>{r.title}</Td><Td>{r.target}</Td><Td>{r.agent}</Td><Td>{r.location_name}</Td><Td>{r.due_date ? formatJalali(r.due_date, { timeZone: "UTC" }) : "—"}</Td><Td>{STATUS[r.status]}</Td>{canManage ? <Td>{r.status === "planned" ? <Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"in_progress")}>شروع</Button> : null}{r.status === "planned" || r.status === "in_progress" ? <><Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"completed")}>تکمیل</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"canceled")}>لغو</Button></> : null}</Td> : null}</DataTableRow>)}</DataTableBody></DataTable> : null}
      {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>صفحه قبل</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>صفحه بعد</Button></div> : null}
    </SectionCard>
    {canManage ? <SectionCard title="ثبت ماموریت" description="بازاریاب و مقصد باید به همان شعبه تعلق داشته باشند. فهرست انتخاب حداکثر ۵۰۰ مورد را نشان می‌دهد.">
      {formError ? <><ErrorBox>{formError}</ErrorBox>{options ? <Button type="button" variant="outline" onClick={() => void loadOptions()}>دریافت دوباره گزینه‌ها</Button> : null}</> : null}
      {!options ? <Button type="button" variant="outline" onClick={() => void loadOptions()}>دریافت گزینه‌ها</Button> : <form onSubmit={submit}>
        <Field label="شعبه"><select className={inputClass} required value={locationId} onChange={(e) => { setLocationId(e.target.value); setTargetId(""); setAgentId(""); }}><option value="">انتخاب شعبه</option>{options.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="مقصد"><select className={inputClass} required value={targetId} onChange={(e) => setTargetId(e.target.value)}><option value="">انتخاب مقصد</option>{options.targets.filter((t) => t.location_id === locationId).map((t) => <option key={t.id} value={t.id}>{t.site_label}</option>)}</select></Field>
        <Field label="بازاریاب"><select className={inputClass} required value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">انتخاب بازاریاب</option>{options.agents.filter((a) => a.location_id === locationId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="عنوان وظیفه"><input className={inputClass} required maxLength={150} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="مهلت (اختیاری)" as="div"><JalaliDatePicker ariaLabel="مهلت ماموریت" value={dueDate} onChange={setDueDate} /></Field>
        <Button type="submit" disabled={busy}>{busy ? "در حال ثبت…" : "ثبت ماموریت"}</Button>
      </form>}
    </SectionCard> : null}
  </div>;
}
