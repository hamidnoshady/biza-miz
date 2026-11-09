"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, inputClass } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { MyMarketingTouchForm } from "./my-marketing-touch-form";
import { MyMarketingTouchHistory } from "./my-marketing-touch-history";
import type { AssignmentStatus } from "@/lib/marketing-operations";

const STATUS: Record<AssignmentStatus, string> = { planned: "برنامه‌ریزی‌شده", in_progress: "در حال انجام", completed: "تکمیل‌شده", canceled: "لغوشده" };
type Row = { id: string; title: string; target: string; location_name: string; status: AssignmentStatus; due_date: string | null };
type List = { assignments: Row[]; hasMore: boolean };
export function MyMarketingAssignmentsSection({ canRecordTouch = false }: { canRecordTouch?: boolean }) {
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [touchAssignment, setTouchAssignment] = useState<Row | null>(null);
  const [touchBusy, setTouchBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false); const [historyVersion, setHistoryVersion] = useState(0);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current; setData(null); setError("");
    const res = await api<List>(`/api/growth/my-marketing-assignments?q=${encodeURIComponent(search)}&page=${page}`);
    if (current !== sequence.current) return;
    if (!res.ok) setError("دریافت ماموریت‌ها ممکن نشد."); else setData(res.data);
  }, [search, page]);
  useEffect(() => { const ref = sequence; void load(); return () => { ref.current++; }; }, [load]);
  async function transition(row: Row, next: "in_progress" | "completed") {
    setBusy(true); setError("");
    const res = await api(`/api/growth/my-marketing-assignments/${encodeURIComponent(row.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected: row.status, next }) });
    setBusy(false);
    if (!res.ok) { setError("تغییر وضعیت ممکن نشد؛ دسترسی یا وضعیت ماموریت ممکن است تغییر کرده باشد. فهرست را دوباره دریافت کنید."); return; }
    await load();
  }
  return <div className="space-y-4"><SectionCard title="ماموریت‌های بازاریابی من" description="فقط ماموریت‌های منتسب به شما در شعب مجاز نمایش داده می‌شود. تکمیل وظیفه مدرک ملاقات، فروش یا پاداش نیست.">
    {canRecordTouch && !showHistory ? <Button type="button" variant="outline" onClick={() => setShowHistory(true)}>نمایش گزارش‌های تعامل من</Button> : null}
    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
      <label htmlFor="my-assignment-search" className="sr-only">جست‌وجوی ماموریت من</label>
      <input id="my-assignment-search" className={inputClass} maxLength={150} value={q} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجوی عنوان" />
      <Button type="submit" variant="outline">جست‌وجو</Button>
    </form>
    {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
    {!data && !error ? <SectionCardSkeleton /> : null}
    {data?.assignments.length === 0 ? <EmptyState>ماموریتی برای شما یافت نشد.</EmptyState> : null}
    {data && data.assignments.length > 0 ? <DataTable caption="ماموریت‌های من"><DataTableHead><Th>عنوان</Th><Th>مقصد</Th><Th>شعبه</Th><Th>مهلت</Th><Th>وضعیت</Th><Th>عملیات</Th></DataTableHead>
      <DataTableBody>{data.assignments.map((r) => <DataTableRow key={r.id}><Td>{r.title}</Td><Td>{r.target}</Td><Td>{r.location_name}</Td><Td>{r.due_date ? formatJalali(r.due_date, { timeZone: "UTC" }) : "—"}</Td><Td>{STATUS[r.status]}</Td><Td>
        {canRecordTouch && r.status !== "canceled" ? <Button type="button" variant="outline" disabled={busy || touchBusy} onClick={() => setTouchAssignment(r)}>گزارش تعامل</Button> : null}
        {r.status === "planned" ? <Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"in_progress")}>شروع</Button> : null}
        {r.status === "planned" || r.status === "in_progress" ? <Button type="button" variant="outline" disabled={busy} onClick={() => void transition(r,"completed")}>تکمیل</Button> : null}
      </Td></DataTableRow>)}</DataTableBody></DataTable> : null}
    {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>صفحه قبل</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>صفحه بعد</Button></div> : null}
  </SectionCard>{canRecordTouch && touchAssignment ? <MyMarketingTouchForm key={touchAssignment.id} assignment={touchAssignment} onBusyChange={setTouchBusy} onCreated={() => setHistoryVersion((v) => v+1)} onClose={() => setTouchAssignment(null)} /> : null}{canRecordTouch && showHistory ? <MyMarketingTouchHistory version={historyVersion} onClose={() => setShowHistory(false)} /> : null}</div>;
}
