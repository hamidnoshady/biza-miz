"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { CRM_SOURCE_LABELS, type CrmSource } from "@/lib/crm-sources";
import { TOUCH_CHANNEL_LABELS, type TouchChannel } from "@/lib/marketing-touchpoints";

type Touch = { id: string; title: string; target: string; agent: string; location_name: string; location_timezone: string; channel: TouchChannel; source: CrmSource; recorded_at: string };
type Result = { touches: Touch[]; hasMore: boolean };

/** A projection of Growth-owned reports, not a second editable activity history. */
export function LeadMarketingHistory({ lead, onClose }: { lead: { id: string; name: string }; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++sequence.current; setData(null); setError("");
    const result = await api<Result>(`/api/growth/marketing-touchpoints/by-lead?leadId=${encodeURIComponent(lead.id)}&page=${page}`);
    if (seq !== sequence.current) return;
    if (!result.ok) setError("دریافت تعاملات ممکن نشد؛ دسترسی و وضعیت برنامهٔ رشد را بررسی کنید.");
    else setData(result.data);
  }, [lead.id, page]);
  useEffect(() => { const ref = sequence; void load(); return () => { ref.current++; }; }, [load]);
  return <SectionCard title={`تعاملات گزارش‌شدهٔ ${lead.name}`} description="فقط گزارش‌های شعبه‌های مجاز نمایش داده می‌شوند. این گزارش‌ها مدرک ملاقات، رضایت، تبدیل یا فروش نیستند.">
    <Button type="button" variant="outline" onClick={onClose}>بستن تعاملات</Button>
    {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
    {!data && !error ? <SectionCardSkeleton /> : null}
    {data?.touches.length === 0 ? <EmptyState>گزارشی در شعبه‌های مجاز یافت نشد.</EmptyState> : null}
    {data && data.touches.length > 0 ? <DataTable caption="تعاملات گزارش‌شدهٔ سرنخ">
      <DataTableHead><Th>ماموریت</Th><Th>مقصد</Th><Th>بازاریاب</Th><Th>شعبه</Th><Th>کانال</Th><Th>منبع گزارش‌شده</Th><Th>زمان ثبت</Th></DataTableHead>
      <DataTableBody>{data.touches.map((touch) => <DataTableRow key={touch.id}><Td>{touch.title}</Td><Td>{touch.target}</Td><Td>{touch.agent}</Td><Td>{touch.location_name}</Td><Td>{TOUCH_CHANNEL_LABELS[touch.channel]}</Td><Td>{CRM_SOURCE_LABELS[touch.source]}</Td><Td>{formatJalali(touch.recorded_at, { withTime: true, timeZone: touch.location_timezone })}</Td></DataTableRow>)}</DataTableBody>
    </DataTable> : null}
    {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page-1)}>صفحه قبل تعاملات</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page+1)}>صفحه بعد تعاملات</Button></div> : null}
  </SectionCard>;
}
