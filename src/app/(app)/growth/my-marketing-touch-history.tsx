"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, inputClass } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { CRM_SOURCE_LABELS, type CrmSource } from "@/lib/crm-sources";
import { TOUCH_CHANNEL_LABELS, type TouchChannel } from "@/lib/marketing-touchpoints";

type Touch = { id: string; title: string; target: string; lead_name: string; location_name: string; location_timezone: string; channel: TouchChannel; source: CrmSource; recorded_at: string };
type List = { touches: Touch[]; hasMore: boolean };
export function MyMarketingTouchHistory({ version, onClose }: { version: number; onClose: () => void }) {
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [data, setData] = useState<List | null>(null); const [error, setError] = useState("");
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++sequence.current; setData(null); setError("");
    const result = await api<List>(`/api/growth/my-marketing-touchpoints?q=${encodeURIComponent(search)}&page=${page}`);
    if (seq !== sequence.current) return;
    if (!result.ok) setError("دریافت گزارش‌ها ممکن نشد؛ دسترسی و وضعیت برنامه را بررسی کنید."); else setData(result.data);
  }, [search,page]);
  useEffect(() => { const ref = sequence; void load(); return () => { ref.current++; }; }, [load,version]);
  return <SectionCard title="گزارش‌های تعامل من" description="فقط گزارش‌هایی که خودتان برای ماموریت‌های منتسب به خودتان در شعب مجاز ثبت کرده‌اید. این گزارش‌ها مدرک ملاقات، رضایت، فروش یا پاداش نیستند.">
    <p>همسانی اطلاعات به‌تنهایی ثابت نمی‌کند که یک تلاش نامشخص ثبت شده است؛ برای جلوگیری از تکرار، تا باز بودن فرم با همان اطلاعات دوباره تلاش کنید.</p>
    <Button type="button" variant="outline" onClick={onClose}>بستن گزارش‌ها</Button><Button type="button" variant="outline" onClick={() => void load()}>به‌روزرسانی گزارش‌ها</Button>
    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
      <label htmlFor="my-touch-search" className="sr-only">جست‌وجوی گزارش تعامل من</label>
      <input id="my-touch-search" className={inputClass} maxLength={150} value={q} onChange={(e) => setQ(e.target.value)} placeholder="عنوان ماموریت یا نام سرنخ" />
      <Button type="submit" variant="outline">جست‌وجوی گزارش‌ها</Button>
    </form>
    {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
    {!data && !error ? <SectionCardSkeleton /> : null}
    {data?.touches.length === 0 ? <EmptyState>گزارشی در دسترسی فعلی شما یافت نشد.</EmptyState> : null}
    {data && data.touches.length > 0 ? <DataTable caption="گزارش‌های تعامل من"><DataTableHead><Th>ماموریت</Th><Th>مقصد</Th><Th>سرنخ</Th><Th>شعبه</Th><Th>کانال</Th><Th>منبع گزارش‌شده</Th><Th>زمان ثبت</Th></DataTableHead>
      <DataTableBody>{data.touches.map((r) => <DataTableRow key={r.id}><Td>{r.title}</Td><Td>{r.target}</Td><Td>{r.lead_name}</Td><Td>{r.location_name}</Td><Td>{TOUCH_CHANNEL_LABELS[r.channel]}</Td><Td>{CRM_SOURCE_LABELS[r.source]}</Td><Td>{formatJalali(r.recorded_at, { withTime: true, timeZone: r.location_timezone })}</Td></DataTableRow>)}</DataTableBody></DataTable> : null}
    {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page-1)}>صفحه قبل گزارش‌ها</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page+1)}>صفحه بعد گزارش‌ها</Button></div> : null}
  </SectionCard>;
}
